import { delay } from 'bluebird';
import * as Dockerode from 'dockerode';
import { EventEmitter } from 'events';
import * as _ from 'lodash';
import StrictEventEmitter from 'strict-event-emitter-types';

import Container, { CommandOutput, StageContainers } from './container';
import Dockerfile from './dockerfile';
import { InvalidArgumentError } from './errors';

export interface LivepushEvents {
	commandExecute: { stageIdx: number; command: string };
	commandOutput: { stageIdx: number; output: CommandOutput };
	commandReturn: { stageIdx: number; returnCode: number; command: string };
	containerRestart: { containerId: string };
	cancel: void;
}

export interface LivepushConstructOpts {
	dockerfileContent: string | Buffer;
	context: string;
	containerId: string;
	stageImages: string[];
	docker: Dockerode;

	// Should we skip restarting the container once a
	// succesful livepush has finished?
	// This is useful for situations where a "watch mode"
	// program runner is being used, for example
	// node-supervisor
	skipContainerRestart?: boolean;
}

type ContainerEventEmitter = StrictEventEmitter<EventEmitter, LivepushEvents>;

export class Livepush extends (EventEmitter as {
	// We need to avoid the tslint errors here, as typescript
	// will not accept the changes proposed
	// tslint:disable-next-line
	new (): ContainerEventEmitter;
}) {
	// Is a livepush process currently running?
	private livepushRunning = false;
	private cancelRun = false;

	private constructor(
		public dockerfile: Dockerfile,
		public containers: StageContainers,
	) {
		super();

		this.assignEventHandlers();
	}

	public static async init(opts: LivepushConstructOpts): Promise<Livepush> {
		const dockerfile = new Dockerfile(opts.dockerfileContent);

		if (dockerfile.stages.length - 1 !== opts.stageImages.length) {
			const dStages = dockerfile.stages.length;
			const argStages = opts.stageImages.length;
			throw new InvalidArgumentError(
				`Dockerfile with ${dStages} stages provided,` +
					` but ${argStages} image IDs passed to livepush constructor (there should be ${dStages -
						1})`,
			);
		}

		const containers: StageContainers = {};
		// create the list of containers, in the order of the
		// stages
		for (const [idx, stageImage] of opts.stageImages.entries()) {
			containers[idx] = await Container.fromImage(
				opts.context,
				opts.docker,
				stageImage,
				// Always skip restarts for intermediate containers
				{ skipRestart: true },
			);
		}
		containers[dockerfile.stages.length - 1] = Container.fromContainerId(
			opts.context,
			opts.docker,
			opts.containerId,
			{
				skipRestart: opts.skipContainerRestart ?? false,
			},
		);

		return new Livepush(dockerfile, containers);
	}

	public async performLivepush(
		addedOrUpdated: string[],
		deleted: string[],
	): Promise<void> {
		const tasks = this.dockerfile.getActionGroupsFromChangedFiles([
			...addedOrUpdated,
			...deleted,
		]);

		if (this.livepushRunning) {
			await this.cancel();
			while (this.cancelRun) {
				await delay(1000);
			}
			_.each(this.containers, container => {
				container.markCancelled(false);
			});
		}
		this.livepushRunning = true;
		try {
			const keys = _.keys(tasks).sort();
			for (const stageIdxStr of keys) {
				const stageIdx = parseInt(stageIdxStr, 10);
				const stageTasks = tasks[stageIdx];

				if (this.cancelRun) {
					break;
				}

				await this.containers[stageIdx].executeActionGroups(
					stageTasks,
					addedOrUpdated,
					deleted,
					this.containers,
				);
			}
		} finally {
			this.livepushRunning = false;
			this.cancelRun = false;
		}
	}

	// Given some fs changes in the context, do we need to
	// perform a livepush?
	public livepushNeeded(addedOrUpdated: string[], deleted: string[]): boolean {
		return !_.isEmpty(
			this.dockerfile.getActionGroupsFromChangedFiles([
				...addedOrUpdated,
				...deleted,
			]),
		);
	}

	public async cleanupIntermediateContainers() {
		const stages = _.keys(this.containers);
		// Dont remove the last container, as this is the
		// application container and we still want that to
		// run
		stages.pop();
		for (const stage of stages) {
			const stageIdx = parseInt(stage, 10);
			const container = this.containers[stageIdx];
			await container.cleanup();
		}
	}

	public async cancel() {
		this.emit('cancel');
		this.cancelRun = true;
		_.each(this.containers, container => {
			container.markCancelled(true);
		});
	}

	public setBuildArgs(buildArgs: Dictionary<string>): void {
		_.each(this.containers, container =>
			container.setBuildArguments(buildArgs),
		);
	}

	private assignEventHandlers() {
		_.each(this.containers, (container, stageIdxStr) => {
			const stageIdx = parseInt(stageIdxStr, 10);
			container.on('commandExecute', command =>
				this.emit('commandExecute', { stageIdx, command }),
			);
			container.on('commandOutput', output =>
				this.emit('commandOutput', { stageIdx, output }),
			);
			container.on('commandReturn', returnInfo =>
				this.emit('commandReturn', { stageIdx, ...returnInfo }),
			);
		});

		const lastContainer = this.containers[this.dockerfile.stages.length - 1];
		lastContainer.on('containerRestart', () =>
			this.emit('containerRestart', { containerId: lastContainer.containerId }),
		);
	}
}

export default Livepush;
