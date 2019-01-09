import * as Bluebird from 'bluebird';
import * as Dockerode from 'dockerode';
import { EventEmitter } from 'events';
import * as _ from 'lodash';
import { fs } from 'mz';
import * as path from 'path';
import { parse } from 'shell-quote';
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
	commandOutput: CommandOutput;
	commandReturn: (returnCode: number) => void;
	containerRestart: void;
}

type ContainerEventEmitter = StrictEventEmitter<EventEmitter, ContainerEvents>;

export class Container extends (EventEmitter as {
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

			const toAdd = this.getAddOperations(
				Dockerfile.fileMatchesForActionGroup(updated, actionGroup),
				actionGroup,
			);

			const toDelete = this.getDeleteOperations(
				Dockerfile.fileMatchesForActionGroup(files.deleted(), actionGroup),
				actionGroup,
			);

			await this.addFiles(toAdd);
			await this.deleteFiles(toDelete);

			// Now we need to execute the commands
			await Promise.all(
				actionGroup.commands.map(command =>
					this.executeCommand(parse(command)),
				),
			);
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
		await this.docker.getContainer(this.containerId).restart();
	}

	private async addFiles(files: AddOperation[]): Promise<void> {
		const binnedOperations = this.getAddOperationsByDestination(files);

		await Bluebird.map(
			_.toPairs(binnedOperations),
			async ([destination, operations]) => {
				const pack = tar.pack();

				for (const operation of operations) {
					const pathOnDisk = path.join(
						this.hostContextPath,
						operation.fromPath,
					);

					await this.addFileToTarPack(
						pack,
						pathOnDisk,
						path.relative(destination, operation.toPath),
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
			await this.executeCommand(command);
		});
	}

	private async addFileToTarPack(
		pack: tar.Pack,
		path: string,
		destination: string,
	): Promise<void> {
		const stat = await fs.stat(path);
		await new Promise((resolve, reject) => {
			const entry = pack.entry(
				{ name: destination, size: stat.size },
				(err?: Error) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				},
			);

			const readStream = fs.createReadStream(path);
			readStream.on('error', reject);
			readStream.pipe(entry);
		});
	}

	private getAddOperationsByDestination(
		ops: AddOperation[],
	): { [destPath: string]: AddOperation[] } {
		// TODO: This could be made more efficient, as we could integrate
		// the subdirectories into a single group, as this can be done
		// when uploading with a tar file
		return _.groupBy(ops, op => path.dirname(op.toPath));
	}

	private getAddOperations(
		files: string[],
		actionGroup: DockerfileActionGroup,
	): AddOperation[] {
		return this.getOperations(files, actionGroup);
	}

	private getDeleteOperations(
		files: string[],
		actionGroup: DockerfileActionGroup,
	): DeleteOperation[] {
		// for every file that we need to delete, find out where it was sent to
		// and return the in-container path
		return _.map(this.getOperations(files, actionGroup), 'toPath');
	}

	private getOperations(
		files: string[],
		actionGroup: DockerfileActionGroup,
	): Array<{ fromPath: string; toPath: string }> {
		return files.map(f => {
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
			const toPath = matchingDep.destinationIsDirectory
				? path.join(matchingDep.containerPath, f.split(path.sep).pop()!)
				: matchingDep.containerPath;

			return {
				fromPath: f,
				toPath,
			};
		});
	}

	private async executeCommand(command: string[]): Promise<number> {
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
}

export default Container;
