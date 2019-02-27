import * as Bluebird from 'bluebird';
import * as Dockerode from 'dockerode';
import { EventEmitter } from 'events';
import * as _ from 'lodash';
import { fs } from 'mz';
import * as Path from 'path';
import * as escape from 'shell-escape';
import * as shell from 'shell-quote';
import * as Stream from 'stream';
import StrictEventEmitter from 'strict-event-emitter-types';
import * as tar from 'tar-stream';

import Dockerfile, { DockerfileActionGroup } from './dockerfile';
import { ContainerNotRunningError, InternalInconsistencyError } from './errors';

/**
 * This structure represents files which have changed that are
 * part of the build context. They should be provided relative to
 * the build context itself, for example:
 * 	build context: /usr/src/app
 * 	changed file: /usr/src/app/src/main.ts
 * should be provided as:
 * 	src/main.ts
 */
export interface ChangedFiles {
	updated: string[];
	added: string[];
	deleted: string[];
}

export class FileUpdates {
	public constructor(public readonly files: ChangedFiles) {}

	public affected(): string[] {
		return this.files.updated
			.concat(this.files.added)
			.concat(this.files.deleted);
	}

	public addedAndUpdated(): string[] {
		return this.files.updated.concat(this.files.added);
	}

	public deleted(): string[] {
		return this.files.deleted;
	}
}

interface AddOperation {
	fromPath: string;
	toPath: string;
}
type DeleteOperation = string;

export interface ExecResult {
	returnCode: number;
	stdoutOutput: Buffer;
	stderrOutput: Buffer;
}

interface CommandOutput {
	command: string[];
	output: Buffer;
	isStderr: boolean;
}

interface ContainerEvents {
	commandExecute: string;
	commandOutput: CommandOutput;
	commandReturn: (returnCode: number) => void;
	containerRestart: void;
}

type ContainerEventEmitter = StrictEventEmitter<EventEmitter, ContainerEvents>;

export class Container extends (EventEmitter as {
	// We need to avoid the tslint errors here, as typescript
	// will not accept the changes proposed
	// tslint:disable-next-line
	new (): ContainerEventEmitter;
}) {
	private dockerfile: Dockerfile;

	public constructor(
		public readonly dockerfileContent: string,
		public readonly hostContextPath: string,
		public containerId: string,
		public readonly docker: Dockerode,
	) {
		super();
		this.dockerfile = new Dockerfile(dockerfileContent);
	}

	public actionsNeeded(files: FileUpdates): DockerfileActionGroup[] {
		// The Dockerfile class itself doesn't care whether a file has been added, changed or deleted,
		// it simply returns the commands which need to happen based on the paths in the COPY directives.
		return this.dockerfile.getActionGroupsFromChangedFiles(files.affected());
	}

	public async performActions(
		files: FileUpdates,
		actionGroups: DockerfileActionGroup[],
	): Promise<void> {
		// Ensure the the container is running
		if (!(await this.checkRunning())) {
			// Throw an error for now, we'll soon handle this case though
			throw new ContainerNotRunningError();
		}

		for (const actionGroup of actionGroups) {
			// get the affected files for this action group
			const updated = files.addedAndUpdated();

			const toAdd = await this.getAddOperations(
				Dockerfile.fileMatchesForActionGroup(updated, actionGroup),
				actionGroup,
			);

			const toDelete = await this.getDeleteOperations(
				Dockerfile.fileMatchesForActionGroup(files.deleted(), actionGroup),
				actionGroup,
			);

			await this.addFiles(toAdd);
			await this.deleteFiles(toDelete);

			// Now we need to execute the commands
			for (const command of actionGroup.commands) {
				const dockerCommand = Container.generateContainerCommand(command);
				await this.executeCommand(dockerCommand);
			}
		}

		// If we made any changes, restart the container
		if (actionGroups.length > 0) {
			await this.restartContainer();
		}
	}

	public async checkRunning(): Promise<boolean> {
		const inspect = await this.docker.getContainer(this.containerId).inspect();
		return inspect.State.Running === true;
	}

	private async restartContainer(): Promise<void> {
		const container = this.docker.getContainer(this.containerId);
		await container.kill();
		await container.start();
	}

	private async addFiles(files: AddOperation[]): Promise<void> {
		const binnedOperations = this.getAddOperationsByDestination(files);

		await Bluebird.map(
			_.toPairs(binnedOperations),
			async ([destination, operations]) => {
				const pack = tar.pack();

				for (const operation of operations) {
					const pathOnDisk = Path.join(
						this.hostContextPath,
						operation.fromPath,
					);

					await this.addFileToTarPack(
						pack,
						pathOnDisk,
						Path.relative(destination, operation.toPath),
					);
				}

				pack.finalize();

				// Now sync the file over to the container
				await this.docker
					.getContainer(this.containerId)
					.putArchive(pack, { path: destination });
			},
		);
	}

	private async deleteFiles(files: DeleteOperation[]): Promise<void> {
		await Bluebird.map(files, async f => {
			// generate the delete command
			const command = ['/bin/rm', '-f', f];
			this.emit('commandExecute', command.join(' '));
			await this.executeCommand(command);
		});
	}

	private async addFileToTarPack(
		pack: tar.Pack,
		path: string,
		destination: string,
	): Promise<void> {
		const stat = await fs.stat(path);

		pack.entry({ name: destination, size: stat.size }, await fs.readFile(path));
	}

	private getAddOperationsByDestination(
		ops: AddOperation[],
	): { [destPath: string]: AddOperation[] } {
		// TODO: This could be made more efficient, as we could integrate
		// the subdirectories into a single group, as this can be done
		// when uploading with a tar file
		return _.groupBy(ops, op => Path.dirname(op.toPath));
	}

	private async getAddOperations(
		files: string[],
		actionGroup: DockerfileActionGroup,
	): Promise<AddOperation[]> {
		return await this.getOperations(files, actionGroup);
	}

	private async getDeleteOperations(
		files: string[],
		actionGroup: DockerfileActionGroup,
	): Promise<DeleteOperation[]> {
		// for every file that we need to delete, find out where it was sent to
		// and return the in-container path
		return _.map(await this.getOperations(files, actionGroup), 'toPath');
	}

	private async getOperations(
		files: string[],
		actionGroup: DockerfileActionGroup,
	): Promise<Array<{ fromPath: string; toPath: string }>> {
		return Promise.all(
			files.map(async f => {
				const matchingDep = Dockerfile.getActionGroupFileDependency(
					f,
					actionGroup,
				);

				/* istanbul ignore next */
				if (matchingDep == null) {
					throw new InternalInconsistencyError(
						'Could not find matching file for action group',
					);
				}

				// TODO: I'm not sure the logic here is actually correct,
				// specifically the way we build the destination when the containerPath
				// is a directory

				// The dockerfile class tries to detect if the destination is a directory,
				// but we can do one better with the actual container, and look directly
				// at the destination
				if (!matchingDep.destinationIsDirectory) {
					matchingDep.destinationIsDirectory = await this.containerPathIsDirectory(
						matchingDep.containerPath,
					);
				}

				// We can also check if the host path is a directory (only if it's not obvious
				// from the dockerfile)
				if (!matchingDep.sourceIsDirectory) {
					matchingDep.sourceIsDirectory = await Container.hostPathIsDirectory(
						Path.join(this.hostContextPath, f),
					);
				}

				const strippedPath = matchingDep.sourceIsDirectory
					? f
					: f.split(Path.sep).pop()!;

				const toPath = matchingDep.destinationIsDirectory
					? Path.join(matchingDep.containerPath, strippedPath)
					: matchingDep.containerPath;

				return {
					fromPath: f,
					toPath,
				};
			}),
		);
	}

	private containerPathIsDirectory = _.memoize(async (path: string) => {
		const output = await this.executeCommandInternal([
			'/usr/bin/test',
			'-d',
			path,
		]);
		return output.exitCode === 0;
	});

	private static hostPathIsDirectory = _.memoize(async (path: string) => {
		const stat = await fs.lstat(path);
		return stat.isDirectory();
	});

	private async executeCommandInternal(
		command: string[],
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		const exec = await this.docker.getContainer(this.containerId).exec({
			Cmd: command,
			AttachStderr: true,
			AttachStdout: true,
		});

		return await new Promise<{
			stdout: string;
			stderr: string;
			exitCode: number;
		}>((resolve, reject) => {
			exec.start((err: Error, stream: Stream.Readable) => {
				if (err) {
					reject(err);
				}

				const stdoutStream = new Stream.PassThrough();
				const stderrStream = new Stream.PassThrough();
				stream.on('error', reject);
				stream.on('end', async () => {
					stdoutStream.end();
					stderrStream.end();
					const inspect = await exec.inspect();
					resolve({
						stdout: Buffer.concat(stdout).toString(),
						stderr: Buffer.concat(stderr).toString(),
						exitCode: inspect.ExitCode,
					});
				});
				this.docker.modem.demuxStream(stream, stdoutStream, stderrStream);
				stderrStream.on('data', d => {
					stderr.push(d);
				});
				stdoutStream.on('data', d => {
					stdout.push(d);
				});
			});
		});
	}

	private async executeCommand(command: string[]): Promise<number> {
		this.emit('commandExecute', command.join(' '));
		// first create an exec instance
		const exec = await this.docker.getContainer(this.containerId).exec({
			Cmd: command,
			AttachStdout: true,
			AttachStderr: true,
		});

		// The exec.start function's promise interface doesn't seem to work,
		// so wrap it in an explicit Promise, and return when the command
		// finishes
		return new Promise<number>((resolve, reject) => {
			exec.start(async (err: Error, stream: Stream.Readable) => {
				/* istanbul ignore next */
				if (err) {
					return reject(err);
				}
				// Create two streams to store the stdout and stderr
				const stdout = new Stream.PassThrough();
				const stderr = new Stream.PassThrough();

				stream.on('end', async () => {
					stdout.end();
					stderr.end();
					const inspect = await exec.inspect();
					resolve(inspect.ExitCode);
				});
				this.docker.modem.demuxStream(stream, stdout, stderr);
				// Now that the streams have ended we should be able to
				// inspect the exec to find the return code
				stderr.on('data', d => {
					this.emit('commandOutput', { command, output: d, isStderr: true });
				});
				stdout.on('data', d => {
					this.emit('commandOutput', { command, output: d, isStderr: false });
				});
			});
		});
	}

	private static generateContainerCommand(command: string): string[] {
		return shell.parse(escape(['/bin/sh', '-c', `${command}`])).map(entry => {
			if (!_.isString(entry)) {
				const entryObj: { [key: string]: string } = entry;
				if (entryObj.op != null) {
					if (entryObj.op === 'glob') {
						return entryObj.pattern;
					} else {
						return entryObj.op;
					}
				}
				return '';
			}
			return entry;
		});
	}
}

export default Container;
