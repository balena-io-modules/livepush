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

	it('should correctly parse live RUN commands', () => {
		expect(parseDockerfile('#dev-run=run-this-command')).to.deep.equal([
			{
				name: 'LIVERUN',
				lineno: 1,
				raw: '#dev-run=run-this-command',
				args: 'run-this-command',
			},
		]);
		expect(parseDockerfile('#dev-run=run --this --command')).to.deep.equal([
			{
				name: 'LIVERUN',
				lineno: 1,
				raw: '#dev-run=run --this --command',
				args: 'run --this --command',
			},
		]);
	});

	it('should correctly parse live RUN commands with exec arguments', () => {
		expect(parseDockerfile('#dev-run=["some", "executable"]')).to.deep.equal([
			{
				name: 'LIVERUN',
				lineno: 1,
				raw: '#dev-run=["some", "executable"]',
				args: '["some", "executable"]',
			},
		]);
	});

	it('should correctly parse live COPY commands', () => {
		expect(parseDockerfile('#dev-copy=asd')).to.deep.equal([
			{
				name: 'LIVECOPY',
				lineno: 1,
				raw: '#dev-copy=asd',
				args: 'asd',
			},
		]);
	});

	it('should correctly parse live COPY commands with spaces', () => {
		expect(parseDockerfile('#dev-copy=file1 file2')).to.deep.equal([
			{
				name: 'LIVECOPY',
				lineno: 1,
				raw: '#dev-copy=file1 file2',
				args: 'file1 file2',
			},
		]);
	});

	it('should correctly live ENV commands with spaces', () => {
		expect(parseDockerfile('#dev-env=UDEV=1 NODE_ENV=dev\n')).to.deep.equal([
			{
				name: 'LIVEENV',
				args: 'UDEV=1 NODE_ENV=dev',
				lineno: 1,
				raw: '#dev-env=UDEV=1 NODE_ENV=dev',
			},
		]);
	});
});
