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
	commandReturn: { stageIdx: number; returnCode: number };
	containerRestart: { containerId: string };
}

type ContainerEventEmitter = StrictEventEmitter<EventEmitter, LivepushEvents>;

export class Livepush extends (EventEmitter as {
	// We need to avoid the tslint errors here, as typescript
	// will not accept the changes proposed
	// tslint:disable-next-line
	new (): ContainerEventEmitter;
}) {
	private constructor(
		public docker: Dockerode,
		public dockerfile: Dockerfile,
		public containers: StageContainers,
	) {
		super();
		this.assignEventHandlers();
	}

	public static async init(
		dockerfileContent: string | Buffer,
		context: string,
		containerId: string,
		stageImages: string[],
		docker: Dockerode,
	): Promise<Livepush> {
		const dockerfile = new Dockerfile(dockerfileContent);

		if (dockerfile.stages.length - 1 !== stageImages.length) {
			const dStages = dockerfile.stages.length;
			const argStages = stageImages.length;
			throw new InvalidArgumentError(
				`Dockerfile with ${dStages} stages provided,` +
					` but ${argStages} image IDs passed to livepush constructor (there should be ${dStages -
						1})`,
			);
		}

		const containers: StageContainers = {};
		// create the list of containers, in the order of the
		// stages
		for (const [idx, stageImage] of stageImages.entries()) {
			containers[idx] = await Container.fromImage(context, docker, stageImage);
		}
		containers[dockerfile.stages.length - 1] = Container.fromContainerId(
			context,
			docker,
			containerId,
		);

		return new Livepush(docker, dockerfile, containers);
	}

	public async performLivepush(
		addedOrUpdated: string[],
		deleted: string[],
	): Promise<void> {
		const tasks = this.dockerfile.getActionGroupsFromChangedFiles(
			addedOrUpdated.concat(deleted),
		);

		const keys = _.keys(tasks).sort();
		for (const stageIdxStr of keys) {
			const stageIdx = parseInt(stageIdxStr, 10);
			const stageTasks = tasks[stageIdx];

			await this.containers[stageIdx].executeActionGroups(
				stageTasks,
				addedOrUpdated,
				deleted,
				this.containers,
			);
		}
	}

	public async cleanupIntermediateContainers() {
		const stages = _.keys(this.containers);
		for (const stage of stages) {
			const stageIdx = parseInt(stage, 10);
			const container = this.containers[stageIdx];
			await container.cleanup();
		}
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
			container.on('commandReturn', returnCode =>
				this.emit('commandReturn', { stageIdx, returnCode }),
			);
		});

		const lastContainer = this.containers[this.dockerfile.stages.length - 1];
		lastContainer.on('containerRestart', () =>
			this.emit('containerRestart', { containerId: lastContainer.containerId }),
		);
	}
}

export default Livepush;
