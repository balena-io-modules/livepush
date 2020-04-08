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
import * as _ from 'lodash';
import * as path from 'path';

import ActionGroup from './action-group';
import { CommandEntry, parseDockerfile } from './dockerfile-parser';
import { DockerfileParseError, UnsupportedError } from './errors';
import Stage from './stage';

export interface StagedActionGroups {
	[stage: number]: ActionGroup[];
}

export class Dockerfile {
	public stages: Stage[];
	public liveCmd: null | string = null;

	private dockerfileContent: string;
	private parsedDockerfile: CommandEntry[];
	private liveDockerfile: string | undefined;
	private hasLiveAction: boolean = false;

	public constructor(
		dockerfileContent: string | Buffer,
		private autoGenerateLiveDockerfile = true,
	) {
		if (Buffer.isBuffer(dockerfileContent)) {
			dockerfileContent = dockerfileContent.toString();
		}
		this.parse(dockerfileContent);
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

	public generateLiveDockerfile(): string {
		// First, if there's no live action, we can just return the
		// original dockerfile
		if (!this.hasLiveAction) {
			return this.dockerfileContent;
		}

		// If we've already generated the dockerfile, don't regenerate
		if (this.liveDockerfile != null) {
			return this.liveDockerfile;
		}

		let foundLiveCmd = false;
		let liveDockerfile = '';

		for (const entry of this.parsedDockerfile) {
			if (entry.name === 'FROM') {
				// If we haven't encountered the liveCmd yet, we can
				// forward this as normal. If we have, we generate
				// the dockerfile, as stages following a liveCmd
				// should be ignored
				if (!foundLiveCmd) {
					liveDockerfile += `${entry.raw}\n`;
				} else {
					break;
				}
			} else if (entry.name === 'RUN') {
				// If we've reached a liveCmd, we no longer care
				// about any run commands, and can skip them,
				// otherwise we forward them as usual
				if (!foundLiveCmd) {
					liveDockerfile += `${entry.raw}\n`;
				}
			} else if (entry.name === 'LIVECMD') {
				foundLiveCmd = true;
				// We add a marker into the generated dockerfile
				// that we can use to work out in which case we
				// should restart the containers. Copies which
				// appear after this marker do not cause a container
				// restart
				liveDockerfile += '#livecmd-marker=1\n';
				// We know that entry.args is always a string here,
				// as the dockerfile-parser module in this project
				// parses it as such (even though the typing is more
				// permissive)
				liveDockerfile += `CMD ${entry.args}\n`;
			} else if (entry.name === 'LIVERUN') {
				// LIVERUN commmands just go straight to the
				// resulting dockerfile
				liveDockerfile += `RUN ${entry.args}\n`;
			} else if (entry.name === 'LIVECOPY') {
				// LIVECOPY commands just go straight to the
				// resulting dockerfile
				liveDockerfile += `COPY ${entry.args}\n`;
			} else if (entry.name === 'CMD') {
				if (!this.liveCmd) {
					liveDockerfile += `${entry.raw}\n`;
				}
			} else {
				// Everything else gets added with no modifications
				liveDockerfile += `${entry.raw}\n`;
			}
		}

		// Also parse this generated file, to update the
		// internal representation
		this.liveDockerfile = liveDockerfile;
		this.parse(liveDockerfile);
		return liveDockerfile;
	}

	private parse(dockerfileContent: string) {
		this.dockerfileContent = dockerfileContent;
		const entries = parseDockerfile(dockerfileContent).map(e => ({
			...e,
			name: e.name.toUpperCase(),
		}));
		this.parsedDockerfile = entries;

		this.stages = [];
		let currentStage: Stage | null = null;
		let stageIdx = 0;
		let causesRestart = true;

		for (const entry of entries) {
			switch (entry.name) {
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
							causesRestart,
						);
					} else {
						// This is a local fs copy
						currentStage.addLocalCopyStep(copyArgs, causesRestart);
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
					currentStage.addWorkdirStep(entry.args, causesRestart);
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

				// Directives
				case 'LIVECMD':
					this.hasLiveAction = true;
					if (this.liveCmd != null) {
						throw new DockerfileParseError(
							'Only a single live cmd should be specified',
						);
					}
					// The following is always a string
					this.liveCmd = entry.args as string;
					break;
				case 'LIVERUN':
					this.hasLiveAction = true;
					break;
				case 'LIVECOPY':
					this.hasLiveAction = true;
					break;
				case 'LIVECMD_MARKER':
					this.hasLiveAction = true;
					causesRestart = false;
					currentStage?.liveCmdFound();
			}
		}

		this.stages.forEach(stage => {
			stage.finalize(causesRestart);
		});

		if (currentStage != null) {
			currentStage.isLast = true;
		}

		if (this.liveDockerfile == null && this.autoGenerateLiveDockerfile) {
			this.generateLiveDockerfile();
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
