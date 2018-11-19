/*
Copyright 2018 Balena Ltd
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
import * as minimatch from 'minimatch';
import * as path from 'path';

import { DockerfileParseError, UnsupportedError } from './errors';

/**
 * This interface represents a file which when
 * changed causes an option group to retrigger
 */
export interface FileDependency {
	/**
	 * The path of the file on disk
	 */
	localPath: string;
	/**
	 * Where this file gets mapped to inside the container
	 */
	containerPath: string;
}

export type Command = string;

/**
 * This interface represents a set of actions to be performed
 * in the same working directory on the container. They are
 * generated given the Dockerfile and a list of changed files.
 */
export interface DockerfileActionGroup {
	/**
	 * A list of commands to run in order
	 */
	commands: Command[];
	/**
	 * A list of files which this group depends on.
	 * What this means is that if any of the files in
	 * this structure changes, every command in the `commands`
	 * field should be re-ran
	 */
	fileDependencies: FileDependency[];
	/**
	 * The directory in the container which these commands should be
	 * run in
	 */
	workDir: string;
}

class Dockerfile {
	public actionGroups: DockerfileActionGroup[] = [];

	public constructor(dockerfileContents: string) {
		this.parse(dockerfileContents);
	}

	private parse(dockerfileContents: string) {
		const entries = parser.parse(dockerfileContents, {
			includeComments: false,
		});

		let workDir = '/';
		let commands: Command[] = [];
		let lastCopy: FileDependency[] = [];

		for (const entry of entries) {
			switch (entry.name.toUpperCase()) {
				case 'ADD':
					// This isn't supported, as adding urls etc can really mess things up.
					throw new UnsupportedError(
						'Dockerfiles containing the ADD instruction are not supported. Please use COPY.',
					);
				case 'COPY':
					// If there are any commands which have occured already, save them as an action
					// group
					if (commands.length > 0) {
						this.actionGroups.push({
							workDir,
							commands,
							fileDependencies: lastCopy,
						});
						commands = [];
					}

					lastCopy = Dockerfile.copyArgsToFileDeps(workDir, entry.args);
					break;
				case 'WORKDIR':
					// Take every command we currently have, and save it as an action group,
					// as encountering another working directory means that every command
					// following must execute in a different action group
					if (commands.length > 0) {
						this.actionGroups.push({
							workDir,
							commands,
							fileDependencies: lastCopy,
						});
					}
					commands = [];
					if (!_.isString(entry.args)) {
						throw new DockerfileParseError('Non-string argument to WORKDIR');
					}
					workDir = entry.args;
					break;
				case 'RUN':
					// Add this to the current set of commands
					commands.push(Dockerfile.processRunArgs(entry.args));
					break;
			}
		}

		// Store any commands left over, or add another action
		// group in case there's been a COPY before the CMD line
		const last = _.last(this.actionGroups) || { fileDependencies: [] };
		if (commands.length > 0 || last.fileDependencies !== lastCopy) {
			this.actionGroups.push({
				workDir,
				commands,
				fileDependencies: lastCopy,
			});
		}
	}

	// TODO: We can probably cache this value
	/**
	 * Get a list of action groups which should be re-executed if any of
	 * the files passed to this function have changed.
	 *
	 * @param files A list of files whose contents have changed. The path
	 * should be relative to the build context
	 */
	public getActionGroupsFromChangedFiles(
		files: string[],
	): DockerfileActionGroup[] {
		let actionGroupIdx = 0;
		for (const actionGroup of this.actionGroups) {
			// FIXME: COPY src/ src/ won't work due to the fact that there isn't a glob on the end of
			// the target - we can fix this by silenty converting src/ to src/*

			// For every dependency, see if it matches the current action group
			const matches = Dockerfile.fileMatchesForActionGroup(files, actionGroup);

			// If any of the files have changed we need to return all
			// action groups which follow, as they could depend on either
			// one of the trigger files, or the output of a previous action
			// group
			if (matches.length > 0) {
				return this.actionGroups.slice(actionGroupIdx);
			}

			++actionGroupIdx;
		}

		return [];
	}

	public static fileMatchesForActionGroup(
		files: string[],
		actionGroup: DockerfileActionGroup,
	): string[] {
		return _(actionGroup.fileDependencies)
			.flatMap(({ localPath }) => minimatch.match(files, localPath))
			.uniq()
			.value();
	}

	private static copyArgsToFileDeps(
		workDir: string,
		copyArgs: string | string[] | { [key: string]: string },
	): FileDependency[] {
		if (!_.isArray(copyArgs)) {
			throw new DockerfileParseError('Non-array arguments passed to COPY');
		}

		// Remove any flags
		copyArgs = Dockerfile.removeDashedArgs(copyArgs);

		if (copyArgs.length < 2) {
			throw new DockerfileParseError(
				'Incorrect argument count for COPY, minimum 2 required',
			);
		}

		// The last entry into the array should be the destination
		let dest = copyArgs.pop() as string;

		// If the destination is already absolute, the workdir doesn't come into it,
		// but a relative destination means relative to the working directory
		if (!path.isAbsolute(dest)) {
			dest = path.join(workDir, dest);
		}

		const isDir = dest.endsWith('/');

		return copyArgs.map(arg => {
			const containerPath = isDir ? path.join(dest, arg) : dest;

			return {
				localPath: arg,
				containerPath,
			};
		});
	}

	private static processRunArgs(
		command: string | string[] | { [key: string]: string },
	): string {
		if (_.isString(command)) {
			return command;
		}

		if (_.isObject(command)) {
			throw new DockerfileParseError(
				'Object arguments not supported for RUN commands',
			);
		}

		return (command as string[]).join(' ');
	}

	private static removeDashedArgs(command: string[]): string[] {
		let wasDashedArg = false;
		return _.reject(command, arg => {
			if (wasDashedArg) {
				wasDashedArg = false;
				return true;
			}

			wasDashedArg = arg.startsWith('--');

			return wasDashedArg;
		});
	}
}

export default Dockerfile;
