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

import ActionGroup, {
	Command,
	fileMatchesForActionGroup,
	LocalCopy,
	LocalDependentActionGroup,
	StageDependentActionGroup,
} from './action-group';
import { DockerfileParseError, InternalInconsistencyError } from './errors';

export class Stage {
	public dependentOnStages: number[] = [];
	public isLast: boolean = false;
	public actionGroups: ActionGroup[] = [
		{
			dependentOnStage: false,
			commands: [],
			copies: [],
			workdir: '/',
		},
	];

	/*
		This var is used to detect whether we create a new action group,
		as we can collect as many copies together into the same action group,
		but to ensure we run the commands in the correct order, a new copy forces
		a new group
	*/
	private lastStepWasCopy: boolean = false;
	private lastWorkdir: string = '/';
	private ungroupedCommands: Command[] = [];

	public constructor(
		public index: number,
		public name: string = index.toString(),
	) {}

	public addLocalCopyStep(args: string[]) {
		const lastActionGroup = _.last(this.actionGroups);

		if (args.length < 2) {
			throw new DockerfileParseError(
				'Minimum two arguments to COPY instruction!',
			);
		}
		const checkedArgs = args as [string, string, ...string[]];

		if (this.canAddCopyToGroup(false)) {
			if (lastActionGroup.dependentOnStage) {
				throw new InternalInconsistencyError(
					'Attempt to add stage copy to local copy action group!',
				);
			}
			const localActionGroup = lastActionGroup as LocalDependentActionGroup;
			localActionGroup.copies = localActionGroup.copies.concat(
				this.copyArgsToCopies(checkedArgs, localActionGroup),
			);
		} else {
			lastActionGroup.commands = lastActionGroup.commands.concat(
				this.ungroupedCommands,
			);
			const actionGroup: LocalDependentActionGroup = {
				dependentOnStage: false,
				commands: [],
				copies: [],
				workdir: this.lastWorkdir,
			};
			actionGroup.copies = this.copyArgsToCopies(checkedArgs, actionGroup);
			this.actionGroups.push(actionGroup);
			this.ungroupedCommands = [];
		}

		this.lastStepWasCopy = true;
	}

	public addStageCopyStep(args: string[], stageIdx: number) {
		const lastActionGroup = _.last(this.actionGroups);

		if (args.length < 2) {
			throw new DockerfileParseError(
				'Minimum two arguments to COPY instruction!',
			);
		}

		const checkedArgs = args as [string, string, ...string[]];

		if (this.canAddCopyToGroup(true, stageIdx)) {
			if (!lastActionGroup.dependentOnStage) {
				throw new Error(
					'Attempt to add local copy to stage copy action group!',
				);
			}

			lastActionGroup.copies = lastActionGroup.copies.concat(
				this.copyArgsToCopies(checkedArgs, lastActionGroup).map(copy => ({
					sourceStage: stageIdx,
					...copy,
				})),
			);
		} else {
			lastActionGroup.commands = lastActionGroup.commands.concat(
				this.ungroupedCommands,
			);
			const actionGroup: StageDependentActionGroup = {
				dependentOnStage: true,
				commands: [],
				stageDependency: stageIdx,
				copies: [],
				workdir: this.lastWorkdir,
			};

			actionGroup.copies = this.copyArgsToCopies(checkedArgs, actionGroup).map(
				copy => ({
					sourceStage: stageIdx,
					...copy,
				}),
			);

			this.actionGroups.push(actionGroup);
			this.ungroupedCommands = [];
		}

		this.lastStepWasCopy = true;

		this.dependentOnStages = _.uniq(this.dependentOnStages.concat(stageIdx));
	}

	public addCommandStep(command: string) {
		this.ungroupedCommands.push(command);
		this.lastStepWasCopy = false;
	}

	public addWorkdirStep(workdir: string) {
		// We need to create a new group, saving any ungrouped commands into
		// the latest group
		const actionGroup = _.last(this.actionGroups)!;
		actionGroup.commands = actionGroup.commands.concat(this.ungroupedCommands);
		this.actionGroups.push({
			copies: [],
			dependentOnStage: false,
			commands: [],
			workdir,
		});
		this.lastWorkdir = workdir;
		this.ungroupedCommands = [];
		this.lastStepWasCopy = false;
	}

	public finalize() {
		const actionGroup = _.last(this.actionGroups) as ActionGroup;
		actionGroup.commands = actionGroup.commands.concat(this.ungroupedCommands);

		// Also filter any action groups which do not have commands or copies,
		// as these are pointless
		this.actionGroups = _.reject(
			this.actionGroups,
			ag => ag.commands.length === 0 && ag.copies.length === 0,
		);
	}

	public getActionGroupsForChangedFiles(files: string[]): ActionGroup[] {
		// Go through the action groups in order, checking if the file should
		// trigger the group, and returning every action group that follows
		for (const [idx, actionGroup] of this.actionGroups.entries()) {
			if (actionGroup.dependentOnStage) {
				// We're not interested in stage copies
				continue;
			}
			const matches = fileMatchesForActionGroup(files, actionGroup);
			if (matches.length > 0) {
				// return this + everything after it
				return this.actionGroups.slice(idx);
			}
		}
		return [];
	}

	public getActionGroupsForChangedStage(stageIdx: number): ActionGroup[] {
		for (const [idx, actionGroup] of this.actionGroups.entries()) {
			if (!actionGroup.dependentOnStage) {
				// We're not interested in non-stage copies
				continue;
			}
			if (actionGroup.stageDependency === stageIdx) {
				return this.actionGroups.slice(idx);
			}
		}

		return [];
	}

	private canAddCopyToGroup(dependentOnStage: false): boolean;
	private canAddCopyToGroup(dependentOnStage: true, stageIdx: number): boolean;
	private canAddCopyToGroup(
		dependentOnStage: boolean,
		stageIdx?: number,
	): boolean {
		if (this.lastStepWasCopy) {
			const actionGroup = _.last(this.actionGroups) as ActionGroup;
			// the last step's last addition was a copy. We can add it to the
			// same group iff the stage dependency matches (or lack thereof)
			if (dependentOnStage) {
				return (
					actionGroup.dependentOnStage &&
					actionGroup.stageDependency === stageIdx
				);
			}
			return !actionGroup.dependentOnStage;
		}
		return false;
	}

	private copyArgsToCopies(
		args: [string, string, ...string[]],
		actionGroup: ActionGroup,
	): LocalCopy[] {
		let dest = args.pop();
		// If this is not an absolute path, it's given relative to the current
		// workdir
		if (!path.isAbsolute(dest)) {
			dest = path.join(actionGroup.workdir, dest);
		}

		return args.map(source => {
			const normalized = path.normalize(source);
			return {
				source: normalized,
				dest,
			};
		});
	}
}

export default Stage;
