/*
Copyright 2018 balena Ltd
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

chai.use(chaiAsPromised);

const { assert, expect } = chai;

import Dockerfile from '../lib/dockerfile';

describe('Dockerfile inspection', () => {
	describe('Action groups', () => {
		it('should correctly generate simple action groups', () => {
			const dockerfileContent = [
				'FROM baseimage',
				'RUN somecommand',
				'RUN anothercommand',
				'RUN multi arg command',
			].join('\n');

			const dockerfile = new Dockerfile(dockerfileContent);

			expect(dockerfile.actionGroups).to.have.length(1);

			const actionGroup = dockerfile.actionGroups[0];
			expect(actionGroup.workDir).to.equal('/');
			expect(actionGroup.fileDependencies).to.have.length(0);

			expect(actionGroup.commands).to.have.length(3);
			expect(actionGroup.commands).to.deep.equal([
				'somecommand',
				'anothercommand',
				'multi arg command',
			]);
		});

		it('should handle simple copies', () => {
			const dockerfileContent = [
				'FROM baseimage',
				'RUN somecommand',
				'COPY a.ts b.ts',
				'RUN anothercommand',
				'RUN multi arg command',
			].join('\n');

			const dockerfile = new Dockerfile(dockerfileContent);

			expect(dockerfile.actionGroups).to.have.length(2);

			let actionGroup = dockerfile.actionGroups[0];
			expect(actionGroup.workDir).to.equal('/');
			expect(actionGroup.fileDependencies).to.have.length(0);
			expect(actionGroup.commands).to.deep.equal(['somecommand']);

			actionGroup = dockerfile.actionGroups[1];
			expect(actionGroup.workDir).to.equal('/');
			expect(actionGroup.fileDependencies).to.have.length(1);
			expect(actionGroup.fileDependencies[0]).to.deep.equal({
				localPath: 'a.ts',
				destinationIsDirectory: false,
				containerPath: '/b.ts',
			});
			expect(actionGroup.commands).to.deep.equal([
				'anothercommand',
				'multi arg command',
			]);
		});

		it('should handle copies with arguments', () => {
			const dockerfileContent = [
				'FROM baseimage',
				'RUN somecommand',
				'COPY --chown root:root a.ts b.ts',
				'RUN anothercommand',
				'RUN multi arg command',
			].join('\n');

			const dockerfile = new Dockerfile(dockerfileContent);

			expect(dockerfile.actionGroups).to.have.length(2);

			let actionGroup = dockerfile.actionGroups[0];
			expect(actionGroup.workDir).to.equal('/');
			expect(actionGroup.fileDependencies).to.have.length(0);
			expect(actionGroup.commands).to.deep.equal(['somecommand']);

			actionGroup = dockerfile.actionGroups[1];
			expect(actionGroup.workDir).to.equal('/');
			expect(actionGroup.fileDependencies).to.have.length(1);
			expect(actionGroup.fileDependencies[0]).to.deep.equal({
				localPath: 'a.ts',
				destinationIsDirectory: false,
				containerPath: '/b.ts',
			});
			expect(actionGroup.commands).to.deep.equal([
				'anothercommand',
				'multi arg command',
			]);
		});

		it('should handle workdir commands', () => {
			const dockerfileContent = [
				'FROM baseimage',
				'WORKDIR /usr/src/app',
				'COPY a.ts b.ts',
				'RUN anothercommand',
				'WORKDIR /usr/src/app/src/',
				'COPY c.ts d.ts',
				'RUN multi arg command',
				'RUN command2',
			].join('\n');

			const dockerfile = new Dockerfile(dockerfileContent);

			expect(dockerfile.actionGroups).to.have.length(2);

			let actionGroup = dockerfile.actionGroups[0];
			expect(actionGroup.workDir).to.equal('/usr/src/app');
			expect(actionGroup.fileDependencies).to.deep.equal([
				{
					localPath: 'a.ts',
					destinationIsDirectory: false,
					containerPath: '/usr/src/app/b.ts',
				},
			]);
			expect(actionGroup.commands).to.have.length(1);
			expect(actionGroup.commands).to.deep.equal(['anothercommand']);

			actionGroup = dockerfile.actionGroups[1];
			expect(actionGroup.workDir).to.equal('/usr/src/app/src/');
			expect(actionGroup.fileDependencies).to.deep.equal([
				{
					localPath: 'c.ts',
					destinationIsDirectory: false,
					containerPath: '/usr/src/app/src/d.ts',
				},
			]);
			expect(actionGroup.commands).to.have.length(2);
			expect(actionGroup.commands).to.deep.equal([
				'multi arg command',
				'command2',
			]);
		});

		it('should handle multiple file copies to a single destination', () => {
			const dockerfileContent = [
				'FROM baseimage',
				'WORKDIR /usr/src/app',
				'COPY c.ts d.ts ./',
				'RUN command',
				'CMD command2',
			].join('\n');

			const dockerfile = new Dockerfile(dockerfileContent);

			expect(dockerfile.actionGroups).to.have.length(1);

			const actionGroup = dockerfile.actionGroups[0];
			expect(actionGroup.workDir).to.equal('/usr/src/app');
			expect(actionGroup.fileDependencies).to.deep.equal([
				{
					localPath: 'c.ts',
					destinationIsDirectory: true,
					containerPath: '/usr/src/app/',
				},
				{
					localPath: 'd.ts',
					destinationIsDirectory: true,
					containerPath: '/usr/src/app/',
				},
			]);
		});

		it('should handle a COPY before a CMD', () => {
			const dockerfileContent = [
				'FROM image',
				'WORKDIR /usr/src/app',
				'COPY a.test b.test',
				'CMD test',
			].join('\n');

			const dockerfile = new Dockerfile(dockerfileContent);
			expect(dockerfile.actionGroups).to.have.length(1);
		});

		it('should correctly detect multiple file dependencies', () => {
			const dockerfileContent = [
				'FROM image',
				'WORKDIR /usr/src/app',
				'COPY a.test b.test',
				'COPY c.test d.test',
				'RUN command',
				'RUN command2',
				'CMD test',
			].join('\n');

			const dockerfile = new Dockerfile(dockerfileContent);
			expect(dockerfile.actionGroups).to.have.length(1);

			const ag = dockerfile.actionGroups[0];
			expect(ag).to.deep.equal({
				workDir: '/usr/src/app',
				fileDependencies: [
					{
						localPath: 'a.test',
						destinationIsDirectory: false,
						containerPath: '/usr/src/app/b.test',
					},
					{
						localPath: 'c.test',
						destinationIsDirectory: false,
						containerPath: '/usr/src/app/d.test',
					},
				],
				commands: ['command', 'command2'],
			});
		});

		it('should correctly generate copies to the current directory', () => {
			const dockerfileContent = [
				'FROM test',
				'WORKDIR /usr/src/app',
				'COPY a.test .',
				'CMD cmd',
			].join('\n');

			const dockerfile = new Dockerfile(dockerfileContent);
			expect(dockerfile.actionGroups).to.have.length(1);

			const ag = dockerfile.actionGroups[0];
			expect(ag.fileDependencies).to.deep.equal([
				{
					localPath: 'a.test',
					destinationIsDirectory: true,
					containerPath: '/usr/src/app',
				},
			]);
		});
	});

	describe('Action group trigger detection', () => {
		// FIXME: Should throw an error when the Dockerfile has changed
		// as currently that should force a full rebuild

		it('should detect action groups to trigger from simple copies', () => {
			const dockerfileContent = [
				'FROM baseimage',
				'RUN command1',
				'COPY a.ts b.ts',
				'RUN command2',
				'RUN command3',
				'COPY c.ts d.ts',
				'RUN command4',
			].join('\n');

			const dockerfile = new Dockerfile(dockerfileContent);

			let groups = dockerfile.getActionGroupsFromChangedFiles(['a.ts']);
			expect(groups).to.have.length(2);
			expect(groups[0].commands).to.have.length(2);

			groups = dockerfile.getActionGroupsFromChangedFiles(['c.ts']);
			expect(groups).to.have.length(1);
			expect(groups[0].commands).to.have.length(1);

			groups = dockerfile.getActionGroupsFromChangedFiles(['d.ts']);
			expect(groups).to.have.length(0);
		});

		it('should detect action groups to trigger from globbed copies', () => {
			const dockerfileContent = [
				'FROM baseimage',
				'RUN command1',
				'COPY src/* src/',
				'RUN command2',
				'RUN command3',
				'COPY test/* test/',
				'RUN command4',
			].join('\n');

			const dockerfile = new Dockerfile(dockerfileContent);

			let groups = dockerfile.getActionGroupsFromChangedFiles(['src/a.ts']);
			expect(groups).to.have.length(2);
			expect(groups[0].commands).to.have.length(2);
			expect(groups[1].commands).to.have.length(1);

			groups = dockerfile.getActionGroupsFromChangedFiles(['test/a.ts']);
			expect(groups).to.have.length(1);
			expect(groups[0].commands).to.have.length(1);

			groups = dockerfile.getActionGroupsFromChangedFiles([
				'src/a.ts',
				'test/a.ts',
			]);
			expect(groups).to.have.length(2);

			groups = dockerfile.getActionGroupsFromChangedFiles(['docs/api.md']);
			expect(groups).to.have.length(0);
		});

		it('should detect action groups to trigger from directory copies', () => {
			let dockerfileContent = [
				'FROM baseimage',
				'COPY src ./',
				'RUN command1',
				'COPY ./ src/',
				'RUN command2',
			].join('\n');

			let dockerfile = new Dockerfile(dockerfileContent);
			let groups = dockerfile.getActionGroupsFromChangedFiles(['src/test.ts']);
			expect(groups).to.have.length(2);

			groups = dockerfile.getActionGroupsFromChangedFiles(['test.ts']);
			expect(groups).to.have.length(1);

			dockerfileContent = [
				'FROM baseimage',
				'COPY . ./',
				'RUN command1',
				'RUN command2',
			].join('\n');

			dockerfile = new Dockerfile(dockerfileContent);

			groups = dockerfile.getActionGroupsFromChangedFiles(['test.ts']);
			expect(groups).to.have.length(1);
			expect(groups[0].commands).to.have.length(2);
		});
	});

	describe('Utilities', () => {
		it('should remove dashed arguments', () => {
			const args = ['--chown', 'root:root', 'a', 'b', 'c'];
			// Cast to any here, as `removeDashedArgs` is private
			expect((Dockerfile as any).removeDashedArgs(args)).to.deep.equal([
				'a',
				'b',
				'c',
			]);
		});

		it('should detect child paths', () => {
			const isChild = (Dockerfile as any).isChildPath;

			assert(isChild('/usr/src/app', '/usr/src/app/src'), 'assert 1');
			assert(isChild('/usr/src/app/', '/usr/src/app/src/'), 'assert 2');
			assert(isChild('/', '/a/'), 'assert 3');
			assert(isChild('/', '/a/'), 'assert 4');
			assert(isChild('/usr/src/', '/usr/src/app/src'), 'assert 5');
			assert(isChild('/usr', '/usr/src/app/src'), 'assert 6');
			assert(!isChild('/usr/src/a/test', '/usr/src/app/test'), 'assert 7');
			assert(!isChild('/usr/src/a', '/usr/src/app/test'), 'assert 8');
			assert(isChild('.', 'index.ts'), 'assert 9');
			assert(isChild('.', 'src/index.ts'), 'assert 10');
			assert(isChild('src', 'src/index.ts', 'assert 11'));
			assert(!isChild('src', 'test/index.ts', 'assert 12'));
		});
	});
});
