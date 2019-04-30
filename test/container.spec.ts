import 'mocha';

import { expect } from 'chai';
import * as sinon from 'sinon';

import * as Bluebird from 'bluebird';
import * as Docker from 'dockerode';
import * as _ from 'lodash';
import { fs } from 'mz';
import * as Path from 'path';
import * as tarFs from 'tar-fs';
import * as tar from 'tar-stream';

import Container from '../lib/container';
import { streamToBuffer } from '../lib/util';

import { Dockerfile } from '../lib';
import { ContainerNotRunningError } from '../lib/errors';
import { resolveFileDestination } from '../lib/stage-copy';
import docker from './docker';

const image = 'alpine:3.1';

let currentContainer: Docker.Container;

interface FileData {
	[name: string]: {
		header: tar.Headers;
		name: string;
		data: string;
	};
}

const getDirectoryFromContainer = async (
	containerId: string,
	path: string,
): Promise<FileData> => {
	const container = docker.getContainer(containerId);
	const stream = await container.getArchive({ path });

	const fileData = {};
	const extract = tar.extract();

	stream.pipe(extract);

	return new Promise<FileData>((resolve, reject) => {
		extract.on('entry', async (header, dataStream, next) => {
			if (header.type === 'file') {
				const data = (await streamToBuffer(dataStream)).toString();

				fileData[header.name] = {
					header,
					name: header.name,
					data,
				};
			}

			next();
		});
		extract.on('error', reject);
		extract.on('finish', () => resolve(fileData));
	});
};

const addFileToContainer = async (
	containerId: string,
	filename: string,
	content: string,
): Promise<void> => {
	const command = Container.generateContainerCommand(
		`printf '${content}' > ${filename}`,
	);
	const returnCode = await (Container.fromContainerId(
		'',
		docker,
		containerId,
	) as any).executeCommandDetached(command);

	expect(returnCode).to.equal(0);
};

const readFile = _.memoize(fs.readFile);

const buildContext = async (context: string): Promise<string> => {
	console.log('Building context:', context);
	const buildStream = await docker.buildImage(tarFs.pack(context), {
		t: 'livepush-test-image:latest',
	});

	await new Promise((resolve, reject) => {
		buildStream.on('end', resolve);
		buildStream.on('error', reject);
		buildStream.resume();
	});

	const container = await docker.createContainer({
		Image: 'livepush-test-image',
		Tty: true,
	});
	await container.start();

	return container.id;
};

const createImageWithFile = async (filename: string, content: string) => {
	const dockerContainer = await docker.createContainer({
		Image: image,
		Tty: true,
		Cmd: ['/bin/sh'],
	});
	await dockerContainer.start();
	const container = Container.fromContainerId('', docker, dockerContainer.id);

	await addFileToContainer(container.containerId, filename, content);

	const { Id } = await docker
		.getContainer(dockerContainer.id)
		.commit({ repo: 'livepush-test-image', tag: filename.replace(/\//g, '') });

	await dockerContainer.remove({ force: true });

	return Id;
};

describe('Containers', () => {
	describe('Interaction', () => {
		before(async () => {
			console.log('  Pulling necessary images...');
			// Pull down the necessary images
			const stream = await docker.pull(image, {});
			await Bluebird.fromCallback(cb =>
				docker.modem.followProgress(stream, cb),
			);
		});

		beforeEach(async () => {
			currentContainer = await docker.createContainer({
				Image: image,
				Tty: true,
				Cmd: ['/bin/sh'],
			});

			await currentContainer.start();
		});

		afterEach(() => {
			return currentContainer.remove({ force: true }).catch(_.noop);
		});

		describe('Container running detection', () => {
			it('should correctly detect a running container', async () => {
				const container = Container.fromContainerId(
					'',
					docker,
					currentContainer.id,
				);
				expect(await container.checkRunning()).to.equal(true);
			});

			it('should correctly detect a stopped container', async () => {
				await currentContainer.stop({ force: true });
				const container = Container.fromContainerId(
					'',
					docker,
					currentContainer.id,
				);
				expect(await container.checkRunning()).to.equal(false);
			});
		});

		describe('Local file synchronisation', () => {
			describe('File addition and updating', () => {
				it('should add a file to a container', async () => {
					const dockerfileContent = [
						`FROM ${image}`,
						'WORKDIR /tmp',
						'COPY a.test b.test',
						'CMD test',
					].join('\n');
					const dockerfile = new Dockerfile(dockerfileContent);

					const context = Path.join(__dirname, 'contexts', 'a');
					const fileData = await readFile(Path.join(context, 'a.test'), 'utf8');
					const container = Container.fromContainerId(
						context,
						docker,
						currentContainer.id,
					);

					const tasks = dockerfile.getActionGroupsFromChangedFiles(['a.test']);
					expect(tasks)
						.to.have.property('0')
						.that.has.length(1);

					await container.executeActionGroups(tasks[0], ['a.test'], [], {});
					const files = await getDirectoryFromContainer(
						currentContainer.id,
						'/tmp',
					);

					expect(files).to.have.property('tmp/b.test');
					const file = files['tmp/b.test'];
					expect(file)
						.to.have.property('name')
						.that.equals('tmp/b.test');
					expect(file)
						.to.have.property('header')
						.that.has.property('size')
						.that.equals(fileData.length);
					expect(file)
						.to.have.property('data')
						.that.equals(fileData);
				});

				it('should add multiple files to a directory in a container', async () => {
					const dockerfileContent = [
						`FROM ${image}`,
						'WORKDIR /tmp',
						'COPY a.test b.test ./',
						'CMD test',
					].join('\n');
					const dockerfile = new Dockerfile(dockerfileContent);

					const context = Path.join(__dirname, 'contexts', 'a');
					const fileA = await readFile(Path.join(context, 'a.test'), 'utf8');
					const fileB = await readFile(Path.join(context, 'b.test'), 'utf8');

					const container = Container.fromContainerId(
						context,
						docker,
						currentContainer.id,
					);

					const tasks = dockerfile.getActionGroupsFromChangedFiles([
						'a.test',
						'b.test',
					]);
					expect(tasks)
						.to.have.property('0')
						.that.has.length(1);

					await container.executeActionGroups(
						tasks[0],
						['a.test', 'b.test'],
						[],
						{},
					);
					const files = await getDirectoryFromContainer(
						currentContainer.id,
						'/tmp',
					);
					expect(Object.keys(files)).to.have.length(2);
					expect(files['tmp/a.test'].data).to.equal(fileA);
					expect(files['tmp/b.test'].data).to.equal(fileB);
				});

				it('should add a file to a different location', async () => {
					const dockerfileContent = [
						`FROM ${image}`,
						'WORKDIR /tmp',
						'COPY a.test b.test',
						'CMD test',
					].join('\n');
					const dockerfile = new Dockerfile(dockerfileContent);

					const context = Path.join(__dirname, 'contexts', 'a');
					const fileA = await readFile(Path.join(context, 'a.test'), 'utf8');
					const fileB = await readFile(Path.join(context, 'b.test'), 'utf8');

					await addFileToContainer(currentContainer.id, '/tmp/b.test', fileB);

					const container = Container.fromContainerId(
						context,
						docker,
						currentContainer.id,
					);

					const tasks = dockerfile.getActionGroupsFromChangedFiles(['a.test']);
					await container.executeActionGroups(tasks[0], ['a.test'], [], {});

					const files = await getDirectoryFromContainer(
						currentContainer.id,
						'/tmp',
					);
					expect(files)
						.to.have.property('tmp/b.test')
						.that.has.property('data')
						.that.equals(fileA);
				});

				it('should add globbed files to a container', async () => {
					const dockerfileContent = [
						`FROM ${image}`,
						'COPY ./* /tmp/',
						'CMD test',
					].join('\n');
					const dockerfile = new Dockerfile(dockerfileContent);

					const context = Path.join(__dirname, 'contexts', 'a');
					const fileA = await readFile(Path.join(context, 'a.test'), 'utf8');
					const fileB = await readFile(Path.join(context, 'b.test'), 'utf8');

					const container = Container.fromContainerId(
						context,
						docker,
						currentContainer.id,
					);

					const tasks = dockerfile.getActionGroupsFromChangedFiles([
						'a.test',
						'b.test',
					]);

					await container.executeActionGroups(
						tasks[0],
						['a.test', 'b.test'],
						[],
						{},
					);

					const files = await getDirectoryFromContainer(
						currentContainer.id,
						'/tmp',
					);

					expect(files)
						.to.have.property('tmp/a.test')
						.that.has.property('data')
						.that.equals(fileA);
					expect(files)
						.to.have.property('tmp/b.test')
						.that.has.property('data')
						.that.equals(fileB);
				});

				it('should correctly consider subdirectories when copying files', async () => {
					const context = Path.join(__dirname, 'contexts', 'b');
					const dockerfile = new Dockerfile(
						await readFile(Path.join(context, 'Dockerfile'), {
							encoding: 'utf8',
						}),
					);

					const container = Container.fromContainerId(
						context,
						docker,
						currentContainer.id,
					);

					const tasks = dockerfile.getActionGroupsFromChangedFiles([
						'test/test.ts',
					]);
					expect(tasks)
						.to.have.property('0')
						.that.has.length(1);

					expect(
						await (container as any).getLocalOperations(
							['test/test.ts'],
							tasks[0][0],
						),
					).to.deep.equal([
						{
							fromPath: 'test/test.ts',
							toPath: '/usr/src/app/test/test.ts',
						},
					]);
				});

				it('should throw an error when the container is not running', done => {
					const dockerfileContent = [
						`FROM ${image}`,
						'COPY a.test /tmp/',
						'CMD test',
					].join('\n');
					const dockerfile = new Dockerfile(dockerfileContent);
					const context = Path.join(__dirname, 'contexts', 'a');

					const container = Container.fromContainerId(
						context,
						docker,
						currentContainer.id,
					);

					const tasks = dockerfile.getActionGroupsFromChangedFiles(['a.test']);
					expect(tasks)
						.to.have.property('0')
						.that.has.length(1);

					currentContainer.stop({ force: true }).then(() => {
						return container
							.executeActionGroups(tasks[0], ['a.test'], [], {})
							.then(() => {
								done(new Error('Non-running container not detected'));
							})
							.catch(e => {
								if (!(e instanceof ContainerNotRunningError)) {
									throw e;
								}
								done();
							});
					});
				});

				it('should correctly copy directories', async () => {
					const context = Path.join(__dirname, 'contexts', 'dir-copy');
					const dockerfileContent = await readFile(
						Path.join(context, 'Dockerfile'),
					);
					const dockerfile = new Dockerfile(dockerfileContent);
					const container = Container.fromContainerId(
						context,
						docker,
						currentContainer.id,
					);
					// @ts-ignore
					await container.executeCommandDetached([
						'/bin/sh',
						'-c',
						'mkdir -p /usr/src/app',
					]);

					const tasks = dockerfile.getActionGroupsFromChangedFiles([
						'src/index.ts',
					]);
					expect(tasks)
						.to.have.property('0')
						.that.has.length(1);

					await container.executeActionGroups(
						tasks[0],
						['src/index.ts'],
						[],
						{},
					);
					const files = await getDirectoryFromContainer(
						currentContainer.id,
						'/usr/src/app',
					);
					expect(files)
						.to.have.property('app/index.ts')
						.that.has.property('data')
						.that.equals(`console.log('hello');\n`);
				});
			});

			describe('File Deletion', () => {
				it('should delete a file from a container', async () => {
					const dockerfileContent = [
						`FROM ${image}`,
						'WORKDIR /tmp',
						'COPY a.test ./',
						'CMD test',
					].join('\n');
					const dockerfile = new Dockerfile(dockerfileContent);

					const context = Path.join(__dirname, 'contexts', 'a');
					const fileData = await readFile(Path.join(context, 'a.test'), 'utf8');

					// Add a file into the container, check that it's there, and then delete it,
					// ensuring it's not there any longer
					await addFileToContainer(
						currentContainer.id,
						'/tmp/a.test',
						fileData,
					);

					let files = await getDirectoryFromContainer(
						currentContainer.id,
						'/tmp',
					);
					expect(files)
						.to.have.property('tmp/a.test')
						.that.has.property('data')
						.that.equals(fileData);

					const container = Container.fromContainerId(
						context,
						docker,
						currentContainer.id,
					);

					const tasks = dockerfile.getActionGroupsFromChangedFiles(['a.test']);
					expect(tasks)
						.to.have.property('0')
						.that.has.length(1);

					await container.executeActionGroups(tasks[0], [], ['a.test'], {});
					files = await getDirectoryFromContainer(currentContainer.id, '/tmp');
					// tslint:disable-next-line
					expect(files).to.be.empty;
				});
				it('should delete a file when it has a different container path', async () => {
					const dockerfileContent = [
						`FROM ${image}`,
						'WORKDIR /tmp',
						'COPY a.test b.test',
						'CMD test',
					].join('\n');
					const dockerfile = new Dockerfile(dockerfileContent);

					const context = Path.join(__dirname, 'contexts', 'a');
					const fileData = await readFile(Path.join(context, 'a.test'), 'utf8');

					// Add a file into the container, check that it's there, and then delete it,
					// ensuring it's not there any longer
					await addFileToContainer(
						currentContainer.id,
						'/tmp/b.test',
						fileData,
					);

					let files = await getDirectoryFromContainer(
						currentContainer.id,
						'/tmp',
					);
					expect(files)
						.to.have.property('tmp/b.test')
						.that.has.property('data')
						.that.equals(fileData);

					const container = Container.fromContainerId(
						context,
						docker,
						currentContainer.id,
					);

					const tasks = dockerfile.getActionGroupsFromChangedFiles(['a.test']);
					expect(tasks)
						.to.have.property('0')
						.that.has.length(1);

					await container.executeActionGroups(tasks[0], [], ['a.test'], {});
					files = await getDirectoryFromContainer(currentContainer.id, '/tmp');
					// tslint:disable-next-line
					expect(files).to.be.empty;
				});

				it('should not throw when a file does not exist', () => {
					const dockerfileContent = [
						`FROM ${image}`,
						'WORKDIR /tmp',
						'COPY a.test b.test',
						'CMD test',
					].join('\n');
					const dockerfile = new Dockerfile(dockerfileContent);

					const context = Path.join(__dirname, 'contexts', 'a');
					const container = Container.fromContainerId(
						context,
						docker,
						currentContainer.id,
					);

					const tasks = dockerfile.getActionGroupsFromChangedFiles(['a.test']);
					expect(tasks)
						.to.have.property('0')
						.that.has.length(1);

					return container.executeActionGroups(tasks[0], [], ['a.test'], {});
				});

				it('should delete multiple files', async () => {
					const dockerfileContent = [
						`FROM ${image}`,
						'WORKDIR /tmp',
						'COPY a.test b.test ./',
						'CMD test',
					].join('\n');
					const dockerfile = new Dockerfile(dockerfileContent);

					const context = Path.join(__dirname, 'contexts', 'a');
					const fileA = await readFile(Path.join(context, 'a.test'), 'utf8');
					const fileB = await readFile(Path.join(context, 'b.test'), 'utf8');

					// Add a file into the container, check that it's there, and then delete it,
					// ensuring it's not there any longer
					await addFileToContainer(currentContainer.id, '/tmp/a.test', fileA);
					await addFileToContainer(currentContainer.id, '/tmp/b.test', fileB);

					const container = Container.fromContainerId(
						context,
						docker,
						currentContainer.id,
					);

					const tasks = dockerfile.getActionGroupsFromChangedFiles([
						'a.test',
						'b.test',
					]);
					expect(tasks)
						.to.have.property('0')
						.that.has.length(1);

					await container.executeActionGroups(
						tasks[0],
						[],
						['a.test', 'b.test'],
						{},
					);
					const files = await getDirectoryFromContainer(
						currentContainer.id,
						'/tmp',
					);
					// tslint:disable-next-line
					expect(files).to.be.empty;
				});
			});
		});

		describe('Container restarting', () => {
			it('should restart a container after making changes', async function() {
				// Reduce the timeout because this is the failure mode
				this.timeout(45000);

				return new Promise(async (resolve, reject) => {
					// Set up an event stream
					const eventStream = await docker.getEvents({
						filter: {
							container: [currentContainer.id],
						},
					});

					let killed = false;
					eventStream.on('data', data => {
						try {
							const obj = JSON.parse(data.toString());
							if (obj.status === 'kill') {
								killed = true;
							} else if (obj.status === 'start') {
								if (killed) {
									resolve();
								} else {
									reject(new Error('Container start request without a kill'));
								}
								// Force killing of the read stream, otherwise
								// the process never finishes (cast to any as
								// this is undocumented)
								(eventStream as any).destroy();
							}
						} catch {
							reject(new Error('Could not read event stream'));
						}
					});

					const dockerfileContent = [
						`FROM ${image}`,
						'WORKDIR /tmp',
						'COPY a.test b.test',
						'CMD test',
					].join('\n');
					const dockerfile = new Dockerfile(dockerfileContent);
					const context = Path.join(__dirname, 'contexts', 'a');

					const container = Container.fromContainerId(
						context,
						docker,
						currentContainer.id,
					);

					const tasks = dockerfile.getActionGroupsFromChangedFiles(['a.test']);

					expect(tasks)
						.to.have.property('0')
						.that.has.length(1);

					await container.executeActionGroups(tasks[0], ['a.test'], [], {});
				});
			});
		});

		describe('Container Utilities', () => {
			describe('Container commands', () => {
				const genCommand = (Container as any).generateContainerCommand;

				it('should correctly generate commands to run inside the container', () => {
					expect(genCommand('apt-get install')).to.deep.equal([
						'/bin/sh',
						'-c',
						`apt-get install`,
					]);
				});

				it('should correctly add env vars to shell commands', () => {
					expect(genCommand('JOBS=max apt-get install')).to.deep.equal([
						'/bin/sh',
						'-c',
						`JOBS=max apt-get install`,
					]);
				});

				it('should correctly quote strings in commands', () => {
					expect(genCommand(`echo 'this is a test string'`)).to.deep.equal([
						'/bin/sh',
						'-c',
						`echo \'this is a test string\'`,
					]);

					expect(genCommand(`echo "this is a test string"`)).to.deep.equal([
						'/bin/sh',
						'-c',
						`echo \"this is a test string\"`,
					]);
				});

				it('should correctly handle operators in commands', () => {
					expect(
						genCommand(`apt-get update && apt-get install curl`),
					).to.deep.equal([
						'/bin/sh',
						'-c',
						`apt-get update && apt-get install curl`,
					]);
				});

				it('should correctly handle operators and strings', () => {
					expect(
						genCommand(
							`git config ---global user.email test@test.com && git config --global user.name 'test person'`,
						),
					).to.deep.equal([
						'/bin/sh',
						'-c',
						`git config ---global user.email test@test.com && git config --global user.name \'test person\'`,
					]);
				});

				it('should correctly handle globs', () => {
					expect(genCommand('ls test/*.ts')).to.deep.equal([
						'/bin/sh',
						'-c',
						`ls test/*.ts`,
					]);
				});

				it('should handle escaping', () => {
					expect(genCommand(`TEST=123 echo "\\$TEST"`)).to.deep.equal([
						'/bin/sh',
						'-c',
						`TEST=123 echo "\\$TEST"`,
					]);

					expect(genCommand(`echo "this \\"is a string\\""`)).to.deep.equal([
						'/bin/sh',
						'-c',
						'echo "this \\"is a string\\""',
					]);
				});
			});
		});

		describe('Container <-> Container interaction', () => {
			let imageId: string;
			let baseContainer: Container;
			beforeEach(async () => {
				imageId = await createImageWithFile('/tmp/testfile', 'test-data');
				baseContainer = await Container.fromImage('', docker, imageId);
			});
			afterEach(async () => {
				await docker
					.getContainer(baseContainer.containerId)
					.remove({ force: true });
				await docker.getImage(imageId).remove({ force: true });
			});

			it('should copy a file from a previous stage', async () => {
				let files = await getDirectoryFromContainer(
					baseContainer.containerId,
					'/tmp',
				);

				expect(files)
					.to.have.property('tmp/testfile')
					.that.has.property('data')
					.that.equals('test-data');

				const dockerfileContent = [
					'FROM base AS base',
					'COPY test /tmp/testfile',
					'FROM base2',
					'COPY --from=base /tmp/testfile /tmp/frombase',
				].join('\n');
				const dockerfile = new Dockerfile(dockerfileContent);

				const container = Container.fromContainerId(
					'.',
					docker,
					currentContainer.id,
				);

				const tasks = dockerfile.getActionGroupsFromChangedFiles(['test']);
				expect(tasks)
					.to.have.property('0')
					.that.has.length(1);
				expect(tasks)
					.to.have.property('1')
					.that.has.length(1);
				expect(tasks[1][0])
					.to.have.property('dependentOnStage')
					.that.equals(true);

				await container.executeActionGroups(tasks[1], ['test'], [], {
					0: baseContainer,
				});

				files = await getDirectoryFromContainer(container.containerId, '/tmp');
				expect(files)
					.to.have.have.property('tmp/frombase')
					.that.has.property('data')
					.that.equals('test-data');
			});

			it('should copy a directory from a previous stage', async () => {
				await addFileToContainer(
					baseContainer.containerId,
					'/tmp/testfile2',
					'second-test',
				);
				const dockerfileContent = [
					'FROM base AS base',
					'COPY testfile testfile2 /tmp/',
					'FROM base2',
					'COPY --from=base /tmp /tmp',
				].join('\n');
				const dockerfile = new Dockerfile(dockerfileContent);

				const container = Container.fromContainerId(
					'',
					docker,
					currentContainer.id,
				);
				const tasks = dockerfile.getActionGroupsFromChangedFiles([
					'testfile',
					'testfile2',
				]);
				await container.executeActionGroups(
					tasks[1],
					['testfile', 'testfile2'],
					[],
					{
						0: baseContainer,
					},
				);

				const files = await getDirectoryFromContainer(
					container.containerId,
					'/tmp',
				);
				expect(files)
					.to.have.property('tmp/testfile')
					.that.has.property('data')
					.that.equals('test-data');
				expect(files)
					.to.have.property('tmp/testfile2')
					.that.has.property('data')
					.that.equals('second-test');
			});

			it('should copy multiple files from a previous stage', async () => {
				await addFileToContainer(
					baseContainer.containerId,
					'/tmp/testfile2',
					'second-test',
				);
				const dockerfileContent = [
					'FROM base AS base',
					'COPY testfile testfile2 /tmp/',
					'FROM base2',
					'COPY --from=base /tmp/testfile /tmp/testfile',
					'COPY --from=base /tmp/testfile2 /tmp/testfile2',
				].join('\n');
				const dockerfile = new Dockerfile(dockerfileContent);

				const container = Container.fromContainerId(
					'',
					docker,
					currentContainer.id,
				);
				const tasks = dockerfile.getActionGroupsFromChangedFiles([
					'testfile',
					'testfile2',
				]);
				await container.executeActionGroups(
					tasks[1],
					['testfile', 'testfile2'],
					[],
					{
						0: baseContainer,
					},
				);

				const files = await getDirectoryFromContainer(
					container.containerId,
					'/tmp',
				);
				expect(files)
					.to.have.property('tmp/testfile')
					.that.has.property('data')
					.that.equals('test-data');
				expect(files)
					.to.have.property('tmp/testfile2')
					.that.has.property('data')
					.that.equals('second-test');
			});

			it('should cascade copies from stages', async () => {
				const dockerfileContent = [
					'FROM base AS base',
					'COPY testfile /tmp/',
					'FROM base2',
					'COPY --from=base /tmp/testfile /tmp/testfile2',
					'FROM base3',
					'COPY --from=1 /tmp/testfile2 /tmp/testfile3',
				].join('\n');
				const dockerfile = new Dockerfile(dockerfileContent);

				const base2Image = await createImageWithFile('/tmp/not-used', 'test');
				const base2Container = await Container.fromImage(
					'',
					docker,
					base2Image,
				);

				const tasks = dockerfile.getActionGroupsFromChangedFiles(['testfile']);
				expect(tasks)
					.to.have.property('0')
					.that.has.length(1);
				expect(tasks)
					.to.have.property('1')
					.that.has.length(1);
				expect(tasks)
					.to.have.property('2')
					.that.has.length(1);

				const container = Container.fromContainerId(
					'',
					docker,
					currentContainer.id,
				);

				await base2Container.executeActionGroups(tasks[1], ['testfile'], [], {
					0: baseContainer,
				});
				let files = await getDirectoryFromContainer(
					base2Container.containerId,
					'/tmp',
				);
				expect(files)
					.to.have.property('tmp/testfile2')
					.that.has.property('data')
					.that.equals('test-data');
				await container.executeActionGroups(tasks[2], ['testfile'], [], {
					1: base2Container,
				});

				files = await getDirectoryFromContainer(container.containerId, '/tmp');
				expect(files)
					.to.have.property('tmp/testfile3')
					.that.has.property('data')
					.that.equals('test-data');
			});
		});

		describe('Command execution', () => {
			it('should run commands in action groups', async () => {
				const dockerfileContent = [
					'FROM base',
					'WORKDIR /usr/src/app',
					'COPY a.test b.test',
					'RUN printf test > /tmp/testfile',
					'CMD test',
				].join('\n');
				const dockerfile = new Dockerfile(dockerfileContent);

				const context = Path.join(__dirname, 'contexts', 'a');
				const container = Container.fromContainerId(
					context,
					docker,
					currentContainer.id,
				);

				const tasks = dockerfile.getActionGroupsFromChangedFiles(['a.test']);
				await container.executeActionGroups(tasks[0], ['a.test'], [], {});
				let files = await getDirectoryFromContainer(
					container.containerId,
					'/usr/src/app',
				);
				expect(files)
					.itself.have.property('app/b.test')
					.that.has.property('data')
					.that.equals('test-data\n');

				files = await getDirectoryFromContainer(container.containerId, '/tmp');
				expect(files)
					.to.have.property('tmp/testfile')
					.that.has.property('data')
					.that.equals('test');
			});

			it('should run commands in the order that they are defined', async () => {
				const dockerfileContent = [
					'FROM base',
					'WORKDIR /usr/src/app',
					'COPY a.test b.test',
					'RUN printf test > /tmp/testfile',
					'RUN rm -f /tmp/testfile',
					'CMD test',
				].join('\n');
				const dockerfile = new Dockerfile(dockerfileContent);

				const context = Path.join(__dirname, 'contexts', 'a');
				const container = Container.fromContainerId(
					context,
					docker,
					currentContainer.id,
				);

				const tasks = dockerfile.getActionGroupsFromChangedFiles(['a.test']);
				await container.executeActionGroups(tasks[0], ['a.test'], [], {});
				const files = await getDirectoryFromContainer(
					container.containerId,
					'/tmp',
				);
				expect(files).to.not.have.property('tmp/testfile');
			});

			it('should not run commands after an execution failure', async () => {
				const dockerfileContent = [
					'FROM base',
					'WORKDIR /usr/src/app',
					'COPY a.test b.test',
					'RUN command-doesnt-exist',
					'RUN printf test > /tmp/testfile',
					'CMD test',
				].join('\n');
				const dockerfile = new Dockerfile(dockerfileContent);

				const context = Path.join(__dirname, 'contexts', 'a');
				const container = Container.fromContainerId(
					context,
					docker,
					currentContainer.id,
				);

				const tasks = dockerfile.getActionGroupsFromChangedFiles(['a.test']);
				await container.executeActionGroups(tasks[0], ['a.test'], [], {});
			});

			it('should provide execution events', async () => {
				const dockerfileContent = [
					'FROM base',
					'WORKDIR /usr/src/app',
					'COPY a.test b.test',
					'RUN printf test > /tmp/testfile',
					'RUN echo "hello"',
					'CMD test',
				].join('\n');
				const dockerfile = new Dockerfile(dockerfileContent);

				const context = Path.join(__dirname, 'contexts', 'a');
				const container = Container.fromContainerId(
					context,
					docker,
					currentContainer.id,
				);

				const exitCode = sinon.stub();
				const output = sinon.stub();
				const execute = sinon.stub();
				const restart = sinon.stub();

				container.on('commandReturn', a => exitCode(a));
				container.on('commandOutput', a => output(a));
				container.on('commandExecute', a => execute(a));
				// Why is this necessary??
				// @ts-ignore
				container.on('containerRestart', a => restart(a));

				const tasks = dockerfile.getActionGroupsFromChangedFiles(['a.test']);
				await container.executeActionGroups(tasks[0], ['a.test'], [], {});

				expect(exitCode.calledTwice).to.equal(true);
				expect(
					exitCode.calledWith({
						returnCode: 0,
						command: 'printf test > /tmp/testfile',
					}),
				).to.equal(true);
				expect(output.calledOnce).to.equal(true);
				expect(restart.calledOnce).to.equal(true);
				expect(execute.calledTwice).to.equal(true);
				expect(execute.calledWith('printf test > /tmp/testfile')).to.equal(
					true,
				);
				expect(execute.calledWith('echo "hello"')).to.equal(true);
			});
		});
	});

	describe('Utilities', () => {
		it('should correctly generate destination paths when copying directories', () => {
			expect(
				resolveFileDestination('/', '/usr/src/app/', '/temp.txt'),
			).to.equal('/usr/src/app/temp.txt');

			expect(
				resolveFileDestination('/usr/src/app', '/', 'app/index.js'),
			).to.equal('/index.js');

			expect(
				resolveFileDestination(
					'/usr/src/app/',
					'/usr/src/app/build',
					'app/index.js',
				),
			).to.equal('/usr/src/app/build/index.js');
		});
	});
});
