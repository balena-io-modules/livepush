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
import * as parser from 'docker-file-parser';
import * as _ from 'lodash';
import * as path from 'path';

import ActionGroup from './action-group';
import { DockerfileParseError, UnsupportedError } from './errors';
import Stage from './stage';

export interface StagedActionGroups {
	[stage: number]: ActionGroup[];
}

export class Dockerfile {
	public stages: Stage[] = [];

	public constructor(dockerfileContent: string | Buffer) {
		this.parse(dockerfileContent.toString());
	}

	public getActionGroupsFromChangedFiles(files: string[]): StagedActionGroups {
		// go through stage by stage, detecting which stages would be affected by
		// this file being changed
		files = files.map(path.normalize);
		const stagedGroups: StagedActionGroups = {};
		for (const [idx, stage] of this.stages.entries()) {
			const actionGroups = stage.getActionGroupsForChangedFiles(files);
			if (actionGroups.length > 0) {
				stagedGroups[idx] = actionGroups;
			}
		}

		// Recursively detect changes in stages. We start with the stages
		// which change as a direct result of a local copy. We then move
		// onto stages which have become invalidated due to a change in
		// a stage that they depend on. We then move onto stages which have
		// been invalidated due to the stages invalidated by other stages,
		// ad infinitum. We should probably add in infinite loop detection,
		// but in general, to get to this point docker would have had to
		// build the dockerfile anyway, so we can assume all is good.
		const buildDependencyGraph = ([stageIdx, ...tail]: number[]): void => {
			// Check all the stages for a dependency on the current stage
			for (const stage of this.stages) {
				if (stage.index === stageIdx) {
					continue;
				}
				if (_.includes(stage.dependentOnStages, stageIdx)) {
					// Get the action groups that this will invalidate
					const invalidatedByStage = stage.getActionGroupsForChangedStage(
						stageIdx,
					);
					// because an invalidated action group invalidates every step after it,
					// we choose the longest chain to save for the stage
					if (
						stagedGroups[stage.index] == null ||
						stagedGroups[stage.index].length < invalidatedByStage.length
					) {
						stagedGroups[stage.index] = invalidatedByStage;
					}

					// Push this stage onto the stack of values to detect
					tail = tail.concat(stage.index);
				}
			}
			if (tail.length === 0) {
				return;
			}
			buildDependencyGraph(tail);
		};

		buildDependencyGraph(_.map(stagedGroups, (_v, k) => parseInt(k, 10)));

		return stagedGroups;
	}

	private parse(dockerfileContent: string) {
		// Until https://github.com/joyent/node-docker-file-parser/issues/8
		// is fixed, we first remove all comments from the
		// dockerfile
		dockerfileContent = dockerfileContent
			.split(/\r?\n/)
			.filter(line => !line.trimLeft().startsWith('#'))
			.join('\n');

		const entries = parser.parse(dockerfileContent, {
			includeComments: false,
		});

		let currentStage: Stage | null = null;
		let stageIdx = 0;

		for (const entry of entries) {
			switch (entry.name.toUpperCase()) {
				case 'FROM':
					const args = entry.args as string;
					const parts = args.split(' ');

					if (parts.length === 1) {
						currentStage = new Stage(stageIdx);
					} else if (parts.length === 3 && parts[1].toUpperCase() === 'AS') {
						currentStage = new Stage(stageIdx, parts[2]);
					} else {
						throw new DockerfileParseError(
							`Could not parse FROM command on line ${entry.lineno}`,
						);
					}

					this.stages.push(currentStage);
					stageIdx++;
					break;
				case 'COPY':
					/* istanbul ignore next */
					if (currentStage == null) {
						throw new DockerfileParseError(
							'COPY outside of stage! (currentStage is not set)',
						);
					}
					/* istanbul ignore next */
					if (!_.isArray(entry.args)) {
						throw new DockerfileParseError(
							`Non-array arguments passed to COPY on line ${entry.lineno}`,
						);
					}
					// Detect if this is a copy from another stage, or from the local fs
					const [flags, copyArgs] = Dockerfile.removeFlags(entry.args);
					if ('from' in flags) {
						// This is a stage copy
						currentStage.addStageCopyStep(
							copyArgs,
							this.stageNameToIndex(flags.from),
						);
					} else {
						// This is a local fs copy
						currentStage.addLocalCopyStep(copyArgs);
					}
					break;
				case 'ADD':
					// This isn't supported, as adding urls etc could really mess things up
					throw new UnsupportedError(
						'Dockerfiles containing the ADD instruction are not supported. Please use COPY.',
					);
				case 'WORKDIR':
					/* istanbul ignore next */
					if (currentStage == null) {
						throw new DockerfileParseError(
							'COPY outside of stage! (currentStage is not set)',
						);
					}
					/* istanbul ignore next */
					if (!_.isString(entry.args)) {
						throw new DockerfileParseError(
							`Non-string argument passed to WORKDIR on line ${entry.lineno}`,
						);
					}
					currentStage.addWorkdirStep(entry.args);
					break;
				case 'RUN':
					/* istanbul ignore next */
					if (currentStage == null) {
						throw new DockerfileParseError(
							'COPY outside of stage! (currentStage is not set)',
						);
					}
					currentStage.addCommandStep(Dockerfile.processRunArgs(entry.args));
					break;
			}
		}

		this.stages.forEach(stage => {
			stage.finalize();
		});

		if (currentStage != null) {
			currentStage.isLast = true;
		}
	}

	private stageNameToIndex(name: string): number {
		const found = _.find(this.stages, { name });
		if (found != null) {
			return found.index;
		}
		// We must assume that the name given is actually an index, and return
		// that
		const idx = parseInt(name, 10);
		if (isNaN(idx)) {
			throw new DockerfileParseError(`Could not find stage with name: ${name}`);
		}
		return idx;
	}

	private static processRunArgs(
		command: string | string[] | { [key: string]: string },
	): string {
		if (_.isString(command)) {
			return command;
		}

		if (_.isArray(command)) {
			return command.join(' ');
		}

		/* istanbul ignore next */
		throw new DockerfileParseError(
			'Object arguments not supported for RUN commands',
		);
	}

	private static removeFlags(args: string[]): [Dictionary<string>, string[]] {
		const [unparsedFlags, nonFlags] = _.partition(args, a =>
			_.startsWith(a, '--'),
		);

		return [
			_(unparsedFlags)
				.map(f => {
					const parts = f.split('=').filter(str => str.length > 0);
					if (parts.length < 2) {
						/* istanbul ignore next */
						throw new DockerfileParseError(`Could not parse flag: ${f}`);
					}
					return [_.trimStart(parts[0], '-'), parts.slice(1).join('=')];
				})
				.fromPairs()
				.value(),
			nonFlags,
		];
	}
}

export default Dockerfile;
