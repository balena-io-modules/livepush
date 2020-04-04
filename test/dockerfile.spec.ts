/*
Copyright 2019 balena Ltd
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
import 'mocha';

import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import { fs } from 'mz';
import * as path from 'path';

chai.use(chaiAsPromised);

const { assert, expect } = chai;

import { DockerfileParseError, UnsupportedError } from '../lib';
import { isChildPath, StageDependentActionGroup } from '../lib/action-group';
import Dockerfile from '../lib/dockerfile';

const dockerfileContent: Dictionary<Buffer> = {};

describe('Dockerfile', () => {
	before(async () => {
		const base = path.join(__dirname, 'dockerfiles');
		const singleStageBase = path.join(base, 'single-stage');
		const multiStageBase = path.join(base, 'multi-stage');
		const liveCmdBase = path.join(base, 'livecmd');

		const pairs = [
			[singleStageBase, 'single'],
			[multiStageBase, 'multi'],
			[liveCmdBase, 'livecmd'],
		];

		for (const [dir, prefix] of pairs) {
			const files = await fs.readdir(dir);
			for (const f of files) {
				dockerfileContent[
					`${prefix}-${f.split('.').pop()}`
				] = await fs.readFile(path.join(dir, f));
			}
		}
	});

	describe('Dockerfile parsing', () => {
		describe('Single stage parsing', () => {
			it('should correctly generate simple action groups', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-a']);

				expect(dockerfile.stages).to.have.length(1);
				expect(dockerfile.stages[0])
					.to.have.property('isLast')
					.that.equals(true);
				expect(dockerfile.stages[0].actionGroups).to.have.length(1);

				const actionGroup = dockerfile.stages[0].actionGroups[0];
				expect(actionGroup.workdir).to.equal('/');
				expect(actionGroup.copies).to.have.length(0);

				expect(actionGroup.commands).to.have.length(3);
				expect(actionGroup.commands).to.deep.equal([
					'somecommand',
					'anothercommand',
					'multi arg command',
				]);
			});

			it('should handle simple copies', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-b']);

				expect(dockerfile.stages).to.have.length(1);
				expect(dockerfile.stages[0])
					.to.have.property('isLast')
					.that.equals(true);
				expect(dockerfile.stages[0].actionGroups).to.have.length(2);

				let actionGroup = dockerfile.stages[0].actionGroups[0];
				expect(actionGroup.workdir).to.equal('/');
				expect(actionGroup.copies).to.have.length(0);
				expect(actionGroup.commands).to.deep.equal(['somecommand']);

				actionGroup = dockerfile.stages[0].actionGroups[1];
				expect(actionGroup.workdir).to.equal('/');
				expect(actionGroup.copies).to.have.length(1);
				expect(actionGroup.copies[0]).to.deep.equal({
					source: 'a.ts',
					dest: '/b.ts',
				});
				expect(actionGroup.commands).to.deep.equal([
					'anothercommand',
					'multi arg command',
				]);
			});

			it('should handle multiple copies', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-c']);
				expect(dockerfile.stages).to.have.length(1);
				expect(dockerfile.stages[0])
					.to.have.property('isLast')
					.that.equals(true);
				expect(dockerfile.stages[0].actionGroups).to.have.length(3);

				const actionGroup = dockerfile.stages[0].actionGroups[2];
				expect(actionGroup.workdir).to.equal('/');
				expect(actionGroup.copies).to.have.length(1);
				expect(actionGroup.commands).to.deep.equal(['second anothercommand']);
				expect(actionGroup.copies).to.deep.equal([
					{
						source: 'c.ts',
						dest: '/d.ts',
					},
				]);
			});

			it('should handle copies with arguments', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-d']);
				expect(dockerfile.stages).to.have.length(1);
				expect(dockerfile.stages[0])
					.to.have.property('isLast')
					.that.equals(true);
				expect(dockerfile.stages[0].actionGroups).to.have.length(2);

				const actionGroup = dockerfile.stages[0].actionGroups[1];
				expect(actionGroup.copies).to.deep.equal([
					{
						source: 'a.ts',
						dest: '/b.ts',
					},
				]);
			});

			it('should handle comments within commands', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-r']);
				expect(dockerfile.stages).to.have.length(1);
				expect(dockerfile.stages[0].actionGroups).to.have.length(1);
				const ag = dockerfile.stages[0].actionGroups[0];

				expect(ag.commands).to.have.length(1);
				expect(ag.commands[0]).to.equal(`echo 'hello' && echo ' world'`);
			});

			it('should handle workdir commands', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-e']);
				expect(dockerfile.stages).to.have.length(1);
				expect(dockerfile.stages[0])
					.to.have.property('isLast')
					.that.equals(true);
				expect(dockerfile.stages[0].actionGroups).to.have.length(2);

				let actionGroup = dockerfile.stages[0].actionGroups[0];
				expect(actionGroup.workdir).to.equal('/usr/src/app');
				expect(actionGroup.copies).to.deep.equal([
					{
						source: 'a.ts',
						dest: '/usr/src/app/b.ts',
					},
				]);

				actionGroup = dockerfile.stages[0].actionGroups[1];
				expect(actionGroup.workdir).to.equal('/usr/src/app/src/');
				expect(actionGroup.copies).to.deep.equal([
					{
						source: 'c.ts',
						dest: '/usr/src/app/src/d.ts',
					},
				]);
			});

			it('should handle multiple file copies to a single destination', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-f']);
				expect(dockerfile.stages).to.have.length(1);
				expect(dockerfile.stages[0])
					.to.have.property('isLast')
					.that.equals(true);
				expect(dockerfile.stages[0].actionGroups).to.have.length(1);

				const actionGroup = dockerfile.stages[0].actionGroups[0];

				expect(actionGroup.workdir).to.equal('/usr/src/app');
				expect(actionGroup.copies).to.deep.equal([
					{ source: 'c.ts', dest: '/usr/src/app/' },
					{ source: 'd.ts', dest: '/usr/src/app/' },
				]);
			});

			it('should handle a COPY before a CMD', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-g']);
				expect(dockerfile.stages).to.have.length(1);
				expect(dockerfile.stages[0])
					.to.have.property('isLast')
					.that.equals(true);
				expect(dockerfile.stages[0].actionGroups).to.have.length(1);
			});

			it('should correctly detect multiple file dependencies', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-h']);

				expect(dockerfile.stages).to.have.length(1);
				expect(dockerfile.stages[0])
					.to.have.property('isLast')
					.that.equals(true);

				expect(dockerfile.stages[0].actionGroups).to.have.length(1);

				const actionGroup = dockerfile.stages[0].actionGroups[0];

				expect(actionGroup.workdir).to.equal('/usr/src/app');
				expect(actionGroup.copies).to.deep.equal([
					{
						source: 'a.test',
						dest: '/usr/src/app/b.test',
					},
					{
						source: 'c.test',
						dest: '/usr/src/app/d.test',
					},
				]);
				expect(actionGroup.commands).to.deep.equal(['command', 'command2']);
			});

			it('should correctly generate copies to the current directory', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-i']);
				expect(dockerfile.stages).to.have.length(1);
				expect(dockerfile.stages[0])
					.to.have.property('isLast')
					.that.equals(true);
				expect(dockerfile.stages[0].actionGroups).to.have.length(1);

				const actionGroup = dockerfile.stages[0].actionGroups[0];

				expect(actionGroup.copies).to.deep.equal([
					{
						source: 'a.test',
						dest: '/usr/src/app',
					},
				]);
			});

			it('should throw when an ADD operation is used', () => {
				expect(() => new Dockerfile(dockerfileContent['single-l'])).to.throw(
					UnsupportedError,
				);
			});

			it('should throw on an incorrect FROM line', () => {
				expect(() => new Dockerfile(dockerfileContent['single-m'])).to.throw(
					DockerfileParseError,
				);
			});

			it('should not return any matches when there is none', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-n']);
				expect(dockerfile.getActionGroupsFromChangedFiles(['a'])).to.deep.equal(
					{},
				);
			});

			it('should group multiple consecutive copies in a single stage', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-o']);
				expect(dockerfile.stages).to.have.length(1);
				expect(dockerfile.stages[0].actionGroups).to.have.length(1);
				expect(dockerfile.stages[0].actionGroups[0].copies).to.have.length(2);
			});

			it('should correctly handle absolute paths', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-p']);
				expect(dockerfile.stages[0].actionGroups[0])
					.to.have.property('copies')
					.that.deep.equals([{ source: 'a', dest: '/usr/src/app/b' }]);
			});

			it('should correctly group multiple stage copies', () => {
				const dockerfile = new Dockerfile(dockerfileContent['multi-j']);
				expect(dockerfile.stages).to.have.length(2);
				expect(dockerfile.stages[1])
					.to.have.property('actionGroups')
					.that.has.length(1);
				expect(dockerfile.stages[1].actionGroups[0])
					.to.have.property('copies')
					.that.has.length(2);
			});

			it('should throw when calling processRunArgs with an object', () => {
				expect(() => (Dockerfile as any).processRunArgs({})).to.throw(
					DockerfileParseError,
				);
			});

			it('should throw when calling copyArgsToCopies with an incorrect input', () => {
				expect(() =>
					(Dockerfile as any).removeFlags(['--from=', 'test']),
				).to.throw(DockerfileParseError);
			});
		});

		describe('Multi-stage parsing', () => {
			it('should correctly detect multiple stages', () => {
				const dockerfile = new Dockerfile(dockerfileContent['multi-a']);
				expect(dockerfile.stages).to.have.length(3);
				expect(dockerfile.stages[2])
					.to.have.property('isLast')
					.that.equals(true);

				expect(dockerfile.stages[0].actionGroups).to.have.length(1);
				expect(dockerfile.stages[1].actionGroups).to.have.length(1);
				expect(dockerfile.stages[2].actionGroups).to.have.length(1);

				expect(dockerfile.stages[0].actionGroups[0].commands).to.deep.equal([
					'command',
				]);
				expect(dockerfile.stages[1].actionGroups[0].commands).to.deep.equal([
					'command2',
				]);
				expect(dockerfile.stages[2].actionGroups[0].commands).to.deep.equal([
					'command3',
				]);
			});

			it('should correctly detect stage dependencies', () => {
				const dockerfile = new Dockerfile(dockerfileContent['multi-a']);
				expect(dockerfile.stages[1].actionGroups[0])
					.to.have.property('dependentOnStage')
					.that.equals(true);
				expect(dockerfile.stages[1].actionGroups[0])
					.to.have.property('stageDependency')
					.that.equals(0);
				expect(dockerfile.stages[2].actionGroups[0])
					.to.have.property('dependentOnStage')
					.that.equals(true);
				expect(dockerfile.stages[2].actionGroups[0])
					.to.have.property('stageDependency')
					.that.equals(1);
			});

			it('should correctly detect multiple stage dependencies within a single stage', () => {
				const dockerfile = new Dockerfile(dockerfileContent['multi-b']);
				expect(dockerfile.stages).to.have.length(3);
				expect(dockerfile.stages[2])
					.to.have.property('isLast')
					.that.equals(true);

				expect(dockerfile.stages[2].actionGroups).to.have.length(2);
				let actionGroup = dockerfile.stages[2].actionGroups[0];
				expect(actionGroup)
					.to.have.property('dependentOnStage')
					.that.equals(true);
				expect(actionGroup)
					.to.have.property('stageDependency')
					.that.equals(1);
				expect(actionGroup.commands).to.have.length(0);
				expect(actionGroup.copies).to.deep.equal([
					{
						source: 'test2',
						dest: '/usr/src/app/test3',
						sourceStage: 1,
					},
				]);
				actionGroup = dockerfile.stages[2].actionGroups[1];
				expect(actionGroup)
					.to.have.property('dependentOnStage')
					.that.equals(true);
				expect(actionGroup)
					.to.have.property('stageDependency')
					.that.equals(2);
				expect(actionGroup.commands).to.deep.equal(['command3']);
				expect(actionGroup.copies).to.deep.equal([
					{
						source: 'test3',
						dest: '/usr/src/app/test4',
						sourceStage: 2,
					},
				]);
			});

			it('should correctly find stage names', () => {
				const dockerfile = new Dockerfile(dockerfileContent['multi-c']);
				expect(dockerfile.stages).to.have.length(2);

				expect(dockerfile.stages[0].name).to.equal('base');
				expect(dockerfile.stages[1].dependentOnStages).to.deep.equal([0]);
			});

			it('should support accessing stages by index', () => {
				const dockerfile = new Dockerfile(dockerfileContent['multi-d']);
				expect(dockerfile.stages).to.have.length(2);
				expect(dockerfile.stages[1].dependentOnStages).to.deep.equal([0]);
			});

			it('should throw when a stage name cannot be found', () => {
				expect(() => new Dockerfile(dockerfileContent['multi-e'])).to.throw(
					DockerfileParseError,
				);
			});

			it('should group consecutive copies referencing the same stage together', () => {
				const dockerfile = new Dockerfile(dockerfileContent['multi-f']);

				expect(dockerfile.stages).to.have.length(2);
				expect(dockerfile.stages[1].actionGroups).to.have.length(1);
			});
		});
	});

	describe('Trigger detection', () => {
		describe('Single stage file trigger detection', () => {
			it('should detect affected action groups', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-b']);

				expect(dockerfile.stages).to.have.length(1);
				expect(dockerfile.stages[0].actionGroups).to.have.length(2);

				const stagedActionGroups = dockerfile.getActionGroupsFromChangedFiles([
					'a.ts',
				]);
				const stagedActionGroups2 = dockerfile.getActionGroupsFromChangedFiles([
					'./a.ts',
				]);

				expect(stagedActionGroups).to.deep.equal(stagedActionGroups2);
				expect(stagedActionGroups).to.have.property('0');
				expect(stagedActionGroups[0]).to.deep.equal([
					{
						copies: [
							{
								source: 'a.ts',
								dest: '/b.ts',
							},
						],
						commands: ['anothercommand', 'multi arg command'],
						dependentOnStage: false,
						workdir: '/',
						restart: true,
					},
				]);
			});

			it('should detect triggers from globbed copies', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-j']);
				expect(dockerfile.stages[0].actionGroups).to.have.length(3);

				let stagedActionGroups = dockerfile.getActionGroupsFromChangedFiles([
					'src/app.ts',
				]);

				expect(stagedActionGroups).to.have.property('0');
				let actionGroups = stagedActionGroups[0];
				expect(actionGroups).to.have.length(2);

				stagedActionGroups = dockerfile.getActionGroupsFromChangedFiles([
					'test/test.ts',
				]);
				expect(stagedActionGroups).to.have.property('0');
				actionGroups = stagedActionGroups[0];
				expect(actionGroups).to.have.length(1);
			});

			it('should detect action groups to trigger from directory copies', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-k']);
				let stagedActionGroups = dockerfile.getActionGroupsFromChangedFiles([
					'src/app.ts',
				]);

				expect(stagedActionGroups).to.have.property('0');
				expect(stagedActionGroups[0]).to.have.length(2);

				stagedActionGroups = dockerfile.getActionGroupsFromChangedFiles([
					'main.ts',
				]);
				expect(stagedActionGroups).to.have.property('0');
				expect(stagedActionGroups[0]).to.have.length(1);
			});
		});

		describe('Multistage trigger detection', () => {
			it('should detect when a stage becomes invalidated due to a parent stage', () => {
				const dockerfile = new Dockerfile(dockerfileContent['multi-g']);
				expect(dockerfile.stages).to.have.length(4);
				// Trigger a file at the root, and check that the second stage triggers
				// (we'll check for propagation below so we can define the test more accurately)
				const stagedActionGroups = dockerfile.getActionGroupsFromChangedFiles([
					'trigger',
				]);

				expect(stagedActionGroups)
					.to.have.property('0')
					.that.has.length(1);
				expect(stagedActionGroups)
					.to.have.property('1')
					.that.has.length(1);

				const childStage = stagedActionGroups[1];
				expect(childStage[0].commands).to.deep.equal(['command2']);
				expect(childStage[0].dependentOnStage).to.equal(true);
				expect(
					(childStage[0] as StageDependentActionGroup).stageDependency,
				).to.equal(0);
				expect(childStage[0].workdir).to.equal('/');
			});

			it('should propagate stage changes', () => {
				const dockerfile = new Dockerfile(dockerfileContent['multi-g']);
				const stagedActionGroups = dockerfile.getActionGroupsFromChangedFiles([
					'trigger',
				]);

				expect(stagedActionGroups)
					.to.have.property('2')
					.that.has.length(1);
				expect(stagedActionGroups)
					.to.have.property('3')
					.that.has.length(1);
			});

			it('should return the longest chain of action groups for a stage', () => {
				const dockerfile = new Dockerfile(dockerfileContent['multi-h']);
				const stagedActionGroups = dockerfile.getActionGroupsFromChangedFiles([
					'a',
				]);
				expect(stagedActionGroups).to.have.property('0');
				expect(stagedActionGroups)
					.to.have.property('1')
					.that.has.length(2);
			});

			it('should not spuriously invalidate a stage', () => {
				const dockerfile = new Dockerfile(dockerfileContent['multi-i']);
				let stagedActionGroups = dockerfile.getActionGroupsFromChangedFiles([
					'a',
				]);
				expect(stagedActionGroups).to.have.property('0');
				expect(stagedActionGroups).to.not.have.property('1');
				expect(stagedActionGroups).to.have.property('2');

				stagedActionGroups = dockerfile.getActionGroupsFromChangedFiles(['c']);
				expect(stagedActionGroups).to.have.property('1');
				expect(stagedActionGroups).to.not.have.property('2');
				expect(stagedActionGroups).to.have.property('3');
			});

			it('should return an empty list when a stage does not depend on another', () => {
				const dockerfile = new Dockerfile(dockerfileContent['multi-i']);
				const stage = dockerfile.stages[2];
				expect(stage.getActionGroupsForChangedStage(1)).to.have.length(0);
			});
		});
	});

	describe('Live cmds', () => {
		it('should correctly detect and store a live cmd', () => {
			const dockerfile = new Dockerfile(dockerfileContent['livecmd-a']);
			expect(dockerfile)
				.to.have.property('liveCmd')
				.that.equals('livecmd');
		});

		it('should correctly store a livecmd with an equals in it', () => {
			const dockerfile = new Dockerfile(dockerfileContent['livecmd-g']);
			expect(dockerfile)
				.to.have.property('liveCmd')
				.that.equals('LIVEPUSH=1 my-command arguments');
		});

		it('should throw an error if a livecmd appears in an intermediate stage', () => {
			expect(
				() => new Dockerfile(dockerfileContent['livecmd-b']),
			).to.not.throw();
		});

		it('should throw if more than one livecmd is specified', () => {
			expect(() => new Dockerfile(dockerfileContent['livecmd-c'])).to.throw(
				DockerfileParseError,
			);
		});

		describe('Build Dockerfile generation', () => {
			it('should return the same Dockerfile when there is no livecmd', () => {
				const dockerfile = new Dockerfile(dockerfileContent['single-a']);
				expect(dockerfile.generateLiveDockerfile()).to.equal(
					dockerfileContent['single-a'].toString(),
				);
			});

			it('should correctly generate a live Dockerfile when a livecmd is present', () => {
				const dockerfile = new Dockerfile(dockerfileContent['livecmd-a']);
				expect(dockerfile.generateLiveDockerfile()).to.equal(
					[
						'FROM base',
						'RUN command',
						'COPY file file',
						'RUN command2',
						'COPY file2 file2',
						'#livecmd-marker=1',
						'CMD livecmd\n',
					].join('\n'),
				);
			});

			it('should correctly generate a live Dockerfile when there is array arguments to RUN and COPY', () => {
				const dockerfile = new Dockerfile(dockerfileContent['livecmd-d']);
				expect(dockerfile.generateLiveDockerfile()).to.equal(
					[
						'FROM test',
						'RUN ["my", "command"]',
						'#livecmd-marker=1',
						'CMD test',
						'COPY ["asd", "asd"]\n',
					].join('\n'),
				);
			});

			it('should correctly passthrough docker directives', () => {
				const dockerfile = new Dockerfile(dockerfileContent['livecmd-e']);
				expect(dockerfile.generateLiveDockerfile().trimRight()).to.equal(
					['FROM test', '#livecmd-marker=1', 'CMD test', '#escape=\\'].join(
						'\n',
					),
				);
			});

			it('should generate a live Dockerfile when the livecmd is not in the final stage', () => {
				const dockerfile = new Dockerfile(dockerfileContent['livecmd-f']);
				expect(dockerfile.generateLiveDockerfile().trimRight()).to.equal(
					['FROM a', 'COPY b b', 'RUN b', '#livecmd-marker=1', 'CMD asd'].join(
						'\n',
					),
				);
			});

			it('should replace the internal represntation after generating the dockerfile', () => {
				const dockerfile = new Dockerfile(dockerfileContent['livecmd-f']);
				dockerfile.generateLiveDockerfile();
				expect(dockerfile.stages).to.have.length(1);
			});
		});

		describe('Restart detection', () => {
			it('should correctly work out which actions cause a restart with a livecmd', () => {
				const dockerfile = new Dockerfile(
					[
						'FROM a',
						'RUN a',
						'COPY a b',
						'#dev-cmd-live=asd',
						'COPY c d',
						'RUN a',
						'COPY e f',
						'CMD a',
					].join('\n'),
				);

				expect(dockerfile.stages).to.have.length(1);

				const stage = dockerfile.stages[0];
				expect(stage.actionGroups).to.have.length(3);
				expect(stage.actionGroups[0].restart).to.be.true;
				expect(stage.actionGroups[1].restart).to.be.true;
				expect(stage.actionGroups[2].restart).to.be.false;
			});
		});
	});

	describe('Utilities', () => {
		it('should detect child paths', () => {
			assert(isChildPath('/usr/src/app', '/usr/src/app/src'), 'assert 1');
			assert(isChildPath('/usr/src/app/', '/usr/src/app/src/'), 'assert 2');
			assert(isChildPath('/', '/a/'), 'assert 3');
			assert(isChildPath('/', '/a/'), 'assert 4');
			assert(isChildPath('/usr/src/', '/usr/src/app/src'), 'assert 5');
			assert(isChildPath('/usr', '/usr/src/app/src'), 'assert 6');
			assert(!isChildPath('/usr/src/a/test', '/usr/src/app/test'), 'assert 7');
			assert(!isChildPath('/usr/src/a', '/usr/src/app/test'), 'assert 8');
			assert(isChildPath('.', 'index.ts'), 'assert 9');
			assert(isChildPath('.', 'src/index.ts'), 'assert 10');
			assert(isChildPath('src', 'src/index.ts'), 'assert 11');
			assert(!isChildPath('src', 'test/index.ts'), 'assert 12');
		});
	});
});
