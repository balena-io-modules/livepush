import { expect } from 'chai';

import { parseDockerfile } from '../lib/dockerfile-parser';

describe('Dockerfile parsing', () => {
	describe('Dockerfile directives', () => {
		it('should correctly parse Dockerfile directives', () => {
			expect(
				parseDockerfile('#dev-cmd-live=webpack-dev-server\n'),
			).to.deep.equal([
				{
					name: 'LIVECMD',
					args: 'webpack-dev-server',
					lineno: 1,
					raw: '#dev-cmd-live=webpack-dev-server',
				},
			]);
		});

		it('should correctly parse Dockerfile directives with spaces', () => {
			expect(
				parseDockerfile('\n\n\n#      dev-cmd-live=webpack-dev-server\n'),
			).to.deep.equal([
				{
					name: 'LIVECMD',
					args: 'webpack-dev-server',
					lineno: 4,
					raw: '#dev-cmd-live=webpack-dev-server',
				},
			]);
		});

		it('should sort Dockerfile directives correctly with normal commands', () => {
			expect(
				parseDockerfile(
					[
						'FROM base',
						'RUN 1',
						'COPY 1',
						'#dev-cmd-live=webpack-dev-server',
						'COPY 2',
						'RUN 2',
						'CMD cmd',
					].join('\n'),
				).map(({ name }) => name),
			).to.deep.equal(['FROM', 'RUN', 'COPY', 'LIVECMD', 'COPY', 'RUN', 'CMD']);

			expect(
				parseDockerfile(
					[
						'FROM base',
						'RUN 1',
						'COPY 1',
						'COPY 2',
						'RUN 2',
						'CMD cmd',
						'#dev-cmd-live=webpack-dev-server',
					].join('\n'),
				).map(({ name }) => name),
			).to.deep.equal(['FROM', 'RUN', 'COPY', 'COPY', 'RUN', 'CMD', 'LIVECMD']);
		});

		it('should sort directives correctly even with empty lines and comments', () => {
			expect(
				parseDockerfile(
					[
						'FROM base',
						'',
						'RUN 1',
						'# a comment',
						'COPY 1',
						'',
						'# another comment',
						'COPY 2',
						'RUN 2',
						'',
						'',
						'',
						'CMD cmd',
						'#dev-cmd-live=webpack-dev-server',
					].join('\n'),
				).map(({ name }) => name),
			).to.deep.equal(['FROM', 'RUN', 'COPY', 'COPY', 'RUN', 'CMD', 'LIVECMD']);
		});
	});

	it('should correctly parse leading spaces', () => {
		expect(
			parseDockerfile(
				['FROM a', `RUN echo 'test\\`, `      test'`, 'CMD test'].join('\n'),
			),
		).to.deep.equal([
			{
				name: 'FROM',
				lineno: 1,
				raw: 'FROM a',
				args: 'a',
			},
			{
				name: 'RUN',
				raw: `RUN echo 'test      test'`,
				// This represent the line which the command
				// *finishes* on
				lineno: 3,
				args: `echo 'test      test'`,
			},
			{
				name: 'CMD',
				lineno: 4,
				args: 'test',
				raw: 'CMD test',
			},
		]);
	});
});
