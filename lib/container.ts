/*
Copyright 2019 Balena Ltd
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
   http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import * as Bluebird from 'bluebird';
import * as Docker from 'dockerode';
import { EventEmitter } from 'events';
import * as _ from 'lodash';
import { fs } from 'mz';
import * as Path from 'path';
import * as escape from 'shell-escape';
import * as shell from 'shell-quote';
import * as Stream from 'stream';
import StrictEventEmitter from 'strict-event-emitter-types';
import * as tar from 'tar-stream';

import ActionGroup, {
	getActionGroupFileFilter,
	getAffectedLocalCopies,
	StageDependentActionGroup,
} from './action-group';
import { ContainerNotRunningError, InternalInconsistencyError } from './errors';
import { copyToStage } from './stage-copy';
import {
	addFileToTarPack,
	CommandExecutionArtifactType,
	hostPathIsDirectory,
	waitForCommandCompletion,
} from './util';

interface LocalAddOperation {
	fromPath: string;
	toPath: string;
}

export interface StageContainers {
	[stageIdx: number]: Container;
}

export interface CommandExecutionContext {
	stdout: Stream.Readable;
	stderr: Stream.Readable;
	exec: Docker.Exec;
}

export interface CommandOutput {
	data: Buffer;
	isStderr: boolean;
}
export interface ContainerEvents {
	commandExecute: string;
	commandOutput: CommandOutput;
	commandReturn: { returnCode: number; command: string };
	containerRestart: void;
}

type ContainerEventEmitter = StrictEventEmitter<EventEmitter, ContainerEvents>;

export interface ContainerConstructOpts {
	skipRestart?: boolean;
}

export class Container extends (EventEmitter as {
	// We need to avoid the tslint errors here, as typescript
	// will not accept the changes proposed
	// tslint:disable-next-line
	new (): ContainerEventEmitter;
}) {
	private cancelled: boolean = false;
	private buildArguments: Dictionary<string> = {};

	private skipRestart = false;

	private constructor(
		private buildContext: string,
		private docker: Docker,
		public containerId: string,
		opts: ContainerConstructOpts,
	) {
		super();

		if (opts.skipRestart != null) {
			this.skipRestart = opts.skipRestart;
		}
	}

	public static fromContainerId(
		buildContext: string,
		docker: Docker,
		containerId: string,
		opts: ContainerConstructOpts = {},
	): Container {
		return new Container(buildContext, docker, containerId, opts);
	}

	public static async fromImage(
		buildContext: string,
		docker: Docker,
		imageId: string,
		opts: ContainerConstructOpts = {},
	): Promise<Container> {
		// Create a container from the image id
		const container = await docker.createContainer({
			Image: imageId,
			Entrypoint: ['/bin/sh', '-c', 'while true; do sleep 3600; done'],
		});
		// And start the container
		await container.start();

		return new Container(buildContext, docker, container.id, opts);
	}

	public async checkRunning(): Promise<boolean> {
		const inspect = await this.docker.getContainer(this.containerId).inspect();
		return inspect.State.Running === true;
	}

	public async restartContainer(): Promise<void> {
		const container = this.docker.getContainer(this.containerId);
		// We restart with a kill and then start, rather than restart,
		// because it's noticeably faster
		await container.kill();
		await container.start();
	}

	public async fetchPathFromContainer(path: string): Promise<Stream.Readable> {
		const stream = await this.docker
			.getContainer(this.containerId)
			.getArchive({ path });

		return stream as any;
	}

	public pathIsDirectory = _.memoize(async (path: string) => {
		const output = await this.executeCommandDetached([
			'/usr/bin/test',
			'-d',
			path,
		]);
		return output === 0;
	});

	public async executeActionGroups(
		actionGroups: ActionGroup[],
		addedOrUpdated: string[],
		deleted: string[],
		containers: StageContainers,
	): Promise<void> {
		if (!(await this.checkRunning())) {
			throw new ContainerNotRunningError();
		}

		for (const actionGroup of actionGroups) {
			if (actionGroup.dependentOnStage) {
				await this.performStagedCopy(actionGroup, containers);
			} else {
				const toAdd = await this.getLocalOperations(
					addedOrUpdated,
					actionGroup,
				);
				const toDelete = _.map(
					await this.getLocalOperations(deleted, actionGroup),
					'toPath',
				);

				await this.addFiles(toAdd);
				await this.deleteFiles(toDelete);
			}

			// After adding the necessary files, we then execute the commands in the
			// order that they appear in the dockerfile
			for (const command of actionGroup.commands) {
				if (this.cancelled) {
					return;
				}
				const returnCode = await this.runActionGroupCommand(command);
				if (returnCode !== 0) {
					// Dont continue if a command failed
					return;
				}
			}
		}

		// If we made any changes, restart the container
		if (!this.skipRestart && actionGroups.length > 0) {
			this.emit('containerRestart');
			await this.restartContainer();
		}
	}

	public async executeCommand(
		command: string[],
	): Promise<CommandExecutionContext> {
		const exec = await this.docker.getContainer(this.containerId).exec({
			Cmd: command,
			Env: this.getBuildArgsForDockerApi(),
			AttachStderr: true,
			AttachStdout: true,
		});

		return await new Promise<CommandExecutionContext>((resolve, reject) => {
			exec.start((err: Error | undefined, stream: Stream.Readable) => {
				if (err) {
					return reject(err);
				}

				const stdout = new Stream.PassThrough();
				const stderr = new Stream.PassThrough();
				stream.on('error', reject);
				stream.on('end', async () => {
					stdout.end();
					stderr.end();
				});
				this.docker.modem.demuxStream(stream, stdout, stderr);

				resolve({
					exec,
					stderr,
					stdout,
				});
			});
		});
	}

	public async cleanup() {
		await this.docker.getContainer(this.containerId).remove({ force: true });
	}

	public markCancelled(cancelled: boolean) {
		this.cancelled = cancelled;
	}

	public setBuildArguments(buildArgs: Dictionary<string>): void {
		this.buildArguments = buildArgs;
	}

	private async runActionGroupCommand(command: string): Promise<number> {
		this.emit('commandExecute', command);
		const dockerCommand = Container.generateContainerCommand(command);
		const exe = await this.executeCommand(dockerCommand);
		let exitCode: number;
		await waitForCommandCompletion(exe, ev => {
			switch (ev.type) {
				case CommandExecutionArtifactType.EXIT_CODE:
					exitCode = ev.code;
					this.emit('commandReturn', { returnCode: exitCode, command });
					break;
				case CommandExecutionArtifactType.STDERR_DATA:
				case CommandExecutionArtifactType.STDOUT_DATA:
					this.emit('commandOutput', {
						data: ev.data,
						isStderr: ev.type === CommandExecutionArtifactType.STDERR_DATA,
					});
					break;
			}
		});
		return exitCode!;
	}

	private async performStagedCopy(
		stage: StageDependentActionGroup,
		containers: StageContainers,
	): Promise<void> {
		// First we need to request the tar stream from the container the source resides in
		const container = containers[stage.stageDependency];
		if (container == null) {
			throw new InternalInconsistencyError(
				`Attempt to copy from stage without a container given. StageIdx: ${stage.stageDependency}`,
			);
		}

		for (const copy of stage.copies) {
			await copyToStage(container, this, copy);
		}
	}

	private async addFiles(operations: LocalAddOperation[]): Promise<void> {
		const pack = tar.pack();
		for (const operation of operations) {
			await addFileToTarPack(
				pack,
				Path.join(this.buildContext, operation.fromPath),
				operation.toPath,
			);
		}
		pack.finalize();
		await this.addFilesToContainer(pack, '/');
	}

	private async deleteFiles(files: string[]): Promise<void> {
		// TODO: There's currently no way to delete an entire
		// directory (nor the interface to tell livepush that
		// a directory has been deleted). This could cause a
		// divergence in expected and actual runtime, so it
		// should be handled
		await Bluebird.map(files, async f => {
			const command = ['/bin/rm', '-f', f];
			await this.executeCommandDetached(command);
		});
	}

	private async getLocalOperations(
		files: string[],
		actionGroup: ActionGroup,
	): Promise<LocalAddOperation[]> {
		const filter = getActionGroupFileFilter(actionGroup);

		const taskPromises = _(files)
			.filter(filter)
			.flatMap(f => {
				const copies = getAffectedLocalCopies(actionGroup, f);

				return copies.map(async ({ file, copy }) => {
					// When detecting if the destination is a directory, firstly we just
					// check the string itself. Any path ending with / is quite clearly
					// a directory, and it means that we can avoid making another docker
					// call
					const destinationIsDirectory =
						_.endsWith(copy.dest, '/') ||
						(await this.pathIsDirectory(copy.dest));

					const sourceIsDirectory = await hostPathIsDirectory(
						Path.join(this.buildContext, file),
					);

					// This workflow is a little confusing, because
					// Dockefile copies are fairly forgiving in what
					// they allow. What we do is try to detect when
					// we're copying a file, and that is not the same
					// as the source. We also check that we are not
					// using a glob, by checking the existence of the source
					const realSource = Path.join(this.buildContext, copy.source);
					// Convert to posix style path for windows only (to preserve any escape chars in non-windows paths)
					let filepath =
						process.platform === 'win32' ? file.replace(/\\/g, '/') : file;
					if (
						!sourceIsDirectory &&
						copy.source !== filepath &&
						(await fs.exists(realSource))
					) {
						filepath = Path.posix.relative(copy.source, filepath);
					}

					const toPath = destinationIsDirectory
						? Path.posix.join(copy.dest, filepath)
						: copy.dest;

					return {
						fromPath: file,
						toPath,
					};
				});
			})
			.value();

		return Promise.all(taskPromises);
	}

	private async executeCommandDetached(command: string[]): Promise<number> {
		const exec = await this.docker.getContainer(this.containerId).exec({
			Cmd: command,
			AttachStderr: true,
			AttachStdout: true,
		});

		return await new Promise<number>((resolve, reject) => {
			exec.start((err: Error | undefined, stream: Stream.Readable) => {
				if (err) {
					return reject(err);
				}
				stream.on('error', reject);
				stream.on('end', async () => {
					const inspect = await exec.inspect();
					resolve(inspect.ExitCode);
				});
				stream.resume();
			});
		});
	}

	public static generateContainerCommand(command: string): string[] {
		return shell.parse(escape(['/bin/sh', '-c', command])).map(entry => {
			if (!_.isString(entry)) {
				const entryObj: Dictionary<string> = entry;
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

	public async addFilesToContainer(
		tarStream: Stream.Readable,
		destination: string,
	): Promise<void> {
		await new Promise((resolve, reject) => {
			// We use the callback interface here, as the
			// dockerode promise interface somehow loses any
			// errors which occur
			this.docker
				.getContainer(this.containerId)
				.putArchive(tarStream, { path: destination }, err => {
					if (err) {
						return reject(err);
					}
					resolve();
				});
		});
	}

	private getBuildArgsForDockerApi(): string[] {
		return _.map(this.buildArguments, (v, k) => `${k}=${v}`);
	}
}

export default Container;
