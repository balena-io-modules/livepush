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
import * as minimatch from 'minimatch';
import * as path from 'path';

export type Command = string;

export interface StageCopy {
	source: string;
	dest: string;
	sourceStage: number;
}

export interface LocalCopy {
	source: string;
	dest: string;
}

interface ActionGroupCore {
	commands: Command[];
	workdir: string;
}

export interface StageDependentActionGroup extends ActionGroupCore {
	dependentOnStage: true;
	copies: StageCopy[];
	stageDependency: number;
}

export interface LocalDependentActionGroup extends ActionGroupCore {
	dependentOnStage: false;
	copies: LocalCopy[];
}

export type ActionGroup = StageDependentActionGroup | LocalDependentActionGroup;

// Exported for tests
export function isChildPath(parent: string, child: string): boolean {
	// from: https://stackoverflow.com/a/45242825/4193583
	const relative = path.relative(parent, child);
	return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function fileMatchesForActionGroup(
	files: string[],
	actionGroup: ActionGroup,
): string[] {
	return _(actionGroup.copies)
		.flatMap(({ source }) =>
			files.filter(f => minimatch(f, source) || isChildPath(source, f)),
		)
		.uniq()
		.value();
}

export default ActionGroup;
