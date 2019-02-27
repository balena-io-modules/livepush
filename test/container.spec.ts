import 'mocha';

import { expect } from 'chai';

import * as Bluebird from 'bluebird';
import * as Docker from 'dockerode';
import * as _ from 'lodash';
import { fs } from 'mz';
import * as path from 'path';
import * as tarFs from 'tar-fs';
import * as tar from 'tar-stream';

import Container, { FileUpdates } from '../lib/container';
import { streamToBuffer } from '../lib/util';

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
		extract.on('entry', async (header, stream, next) => {
			if (header.type === 'file') {
				const data = (await streamToBuffer(stream)).toString();

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
	path: string,
	filename: string,
	content: string,
): Promise<void> => {
	const container = docker.getContainer(containerId);

	const pack = tar.pack();
	pack.entry({ name: filename }, content);
	pack.finalize();

	await container.putArchive(pack, { path });
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
				const container = new Container('', '.', currentContainer.id, docker);
				expect(await container.checkRunning()).to.equal(true);
			});

			it('should correctly detect a stopped container', async () => {
				await currentContainer.stop({ force: true });
				const container = new Container('', '.', currentContainer.id, docker);
				expect(await container.checkRunning()).to.equal(false);
			});
		});

		describe('File synchronisation', () => {
			describe('File addition and updating', () => {
				it('should add a file to a container', async () => {
					const dockerfileContent = [
						`FROM ${image}`,
						'WORKDIR /tmp',
						'COPY a.test b.test',
						'CMD test',
					].join('\n');

					const context = path.join(__dirname, 'contexts', 'a');
					const fileData = await readFile(path.join(context, 'a.test'), 'utf8');

					const container = new Container(
						dockerfileContent,
						context,
						currentContainer.id,
						docker,
					);

					const changedFiles = new FileUpdates({
						updated: [],
						deleted: [],
						added: ['a.test'],
					});

					const tasks = container.actionsNeeded(changedFiles);

					expect(tasks).to.have.length(1);

					await container.performActions(changedFiles, tasks);
					const files = await getDirectoryFromContainer(
						container.containerId,
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

					const context = path.join(__dirname, 'contexts', 'a');
					const fileA = await readFile(path.join(context, 'a.test'), 'utf8');
					const fileB = await readFile(path.join(context, 'b.test'), 'utf8');

					const container = new Container(
						dockerfileContent,
						context,
						currentContainer.id,
						docker,
					);

					const changedFiles = new FileUpdates({
						updated: ['a.test', 'b.test'],
						deleted: [],
						added: [],
					});

					const tasks = container.actionsNeeded(changedFiles);
					expect(tasks).to.have.length(1);

					await container.performActions(changedFiles, tasks);
					const files = await getDirectoryFromContainer(
						container.containerId,
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

					const context = path.join(__dirname, 'contexts', 'a');
					const fileA = await readFile(path.join(context, 'a.test'), 'utf8');
					const fileB = await readFile(path.join(context, 'b.test'), 'utf8');

					await addFileToContainer(
						currentContainer.id,
						'/tmp',
						'b.test',
						fileB,
					);

					const container = new Container(
						dockerfileContent,
						context,
						currentContainer.id,
						docker,
					);

					const changedFiles = new FileUpdates({
						updated: ['a.test'],
						deleted: [],
						added: [],
					});

					const actions = container.actionsNeeded(changedFiles);
					expect(actions).to.have.length(1);

					await container.performActions(changedFiles, actions);

					const files = await getDirectoryFromContainer(
						container.containerId,
						'/tmp',
					);
					expect(files)
						.to.have.property('tmp/b.test')
						.that.has.property('data')
						.that.equals(fileA);
				});

				it('should overwrite a present file', async () => {
					const dockerfileContent = [
						`FROM ${image}`,
						'WORKDIR /tmp',
						'COPY a.test b.test',
						'CMD test',
					].join('\n');

					const context = path.join(__dirname, 'contexts', 'a');
					const fileA = await readFile(path.join(context, 'a.test'), 'utf8');
					const fileB = await readFile(path.join(context, 'b.test'), 'utf8');

					await addFileToContainer(
						currentContainer.id,
						'/tmp',
						'b.test',
						fileB,
					);

					const container = new Container(
						dockerfileContent,
						context,
						currentContainer.id,
						docker,
					);

					const changedFiles = new FileUpdates({
						updated: ['a.test'],
						deleted: [],
						added: [],
					});

					const actions = container.actionsNeeded(changedFiles);
					expect(actions).to.have.length(1);

					await container.performActions(changedFiles, actions);

					const files = await getDirectoryFromContainer(
						container.containerId,
						'/tmp',
					);
					expect(files)
						.to.have.property('tmp/b.test')
						.that.has.property('data')
						.that.equals(fileA);
				});

				it('should add a file to a absolute path', async () => {
					const dockerfileContent = [
						`FROM ${image}`,
						'COPY a.test /tmp/',
						'CMD test',
					].join('\n');

					const context = path.join(__dirname, 'contexts', 'a');
					const fileA = await readFile(path.join(context, 'a.test'), 'utf8');

					const container = new Container(
						dockerfileContent,
						context,
						currentContainer.id,
						docker,
					);

					const changedFiles = new FileUpdates({
						updated: ['a.test'],
						deleted: [],
						added: [],
					});

					const actions = container.actionsNeeded(changedFiles);
					expect(actions).to.have.length(1);

					await container.performActions(changedFiles, actions);

					const files = await getDirectoryFromContainer(
						container.containerId,
						'/tmp',
					);
					expect(files)
						.to.have.property('tmp/a.test')
						.that.has.property('data')
						.that.equals(fileA);
				});

				it('should add globbed files to a container', async () => {
					const dockerfileContent = [
						`FROM ${image}`,
						'COPY ./* /tmp/',
						'CMD test',
					].join('\n');

					const context = path.join(__dirname, 'contexts', 'a');
					const fileA = await readFile(path.join(context, 'a.test'), 'utf8');
					const fileB = await readFile(path.join(context, 'b.test'), 'utf8');

					const container = new Container(
						dockerfileContent,
						context,
						currentContainer.id,
						docker,
					);

					const changedFiles = new FileUpdates({
						updated: ['a.test', 'b.test'],
						deleted: [],
						added: [],
					});

					const actions = container.actionsNeeded(changedFiles);
					expect(actions).to.have.length(1);

					await container.performActions(changedFiles, actions);

					const files = await getDirectoryFromContainer(
						container.containerId,
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
					const context = path.join(__dirname, 'contexts', 'b');

					const container = new Container(
						await readFile(path.join(context, 'Dockerfile'), {
							encoding: 'utf8',
						}),
						context,
						currentContainer.id,
						docker,
					);

					const changedFiles = new FileUpdates({
						updated: ['test/test.ts'],
						deleted: [],
						added: [],
					});

					const actions = container.actionsNeeded(changedFiles);
					expect(actions).to.have.length(1);

					expect(
						await (container as any).getOperations(
							['test/test.ts'],
							actions[0],
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

					const context = path.join(__dirname, 'contexts', 'a');

					const container = new Container(
						dockerfileContent,
						context,
						currentContainer.id,
						docker,
					);

					const changedFiles = new FileUpdates({
						updated: ['a.test'],
						deleted: [],
						added: [],
					});

					const actions = container.actionsNeeded(changedFiles);
					expect(actions).to.have.length(1);

					currentContainer.stop({ force: true }).then(() => {
						return container
							.performActions(changedFiles, actions)
							.then(() => {
								done(new Error('Non-running container not detected'));
							})
							.catch(() => done());
					});
				});
			});

			describe('File deletion', () => {
				it('should delete a file from a container', async () => {
					const dockerfileContent = [
						`FROM ${image}`,
						'WORKDIR /tmp',
						'COPY a.test ./',
						'CMD test',
					].join('\n');

					const context = path.join(__dirname, 'contexts', 'a');
					const fileData = await readFile(path.join(context, 'a.test'), 'utf8');

					// Add a file into the container, check that it's there, and then delete it,
					// ensuring it's not there any longer
					await addFileToContainer(
						currentContainer.id,
						'/tmp',
						'a.test',
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

					const container = new Container(
						dockerfileContent,
						context,
						currentContainer.id,
						docker,
					);

					const changedFiles = new FileUpdates({
						updated: [],
						deleted: ['a.test'],
						added: [],
					});

					const tasks = container.actionsNeeded(changedFiles);
					expect(tasks).to.have.length(1);

					await container.performActions(changedFiles, tasks);
					files = await getDirectoryFromContainer(
						container.containerId,
						'/tmp',
					);
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

					const context = path.join(__dirname, 'contexts', 'a');
					const fileData = await readFile(path.join(context, 'a.test'), 'utf8');

					// Add a file into the container, check that it's there, and then delete it,
					// ensuring it's not there any longer
					await addFileToContainer(
						currentContainer.id,
						'/tmp',
						'b.test',
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

					const container = new Container(
						dockerfileContent,
						context,
						currentContainer.id,
						docker,
					);

					const changedFiles = new FileUpdates({
						updated: [],
						deleted: ['a.test'],
						added: [],
					});

					const tasks = container.actionsNeeded(changedFiles);
					expect(tasks).to.have.length(1);

					await container.performActions(changedFiles, tasks);
					files = await getDirectoryFromContainer(
						container.containerId,
						'/tmp',
					);
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

					const context = path.join(__dirname, 'contexts', 'a');
					const container = new Container(
						dockerfileContent,
						context,
						currentContainer.id,
						docker,
					);

					const changedFiles = new FileUpdates({
						updated: [],
						deleted: ['a.test'],
						added: [],
					});

					const tasks = container.actionsNeeded(changedFiles);
					expect(tasks).to.have.length(1);

					return container.performActions(changedFiles, tasks);
				});

				it('should delete multiple files', async () => {
					const dockerfileContent = [
						`FROM ${image}`,
						'WORKDIR /tmp',
						'COPY a.test b.test ./',
						'CMD test',
					].join('\n');

					const context = path.join(__dirname, 'contexts', 'a');
					const fileA = await readFile(path.join(context, 'a.test'), 'utf8');
					const fileB = await readFile(path.join(context, 'b.test'), 'utf8');

					// Add a file into the container, check that it's there, and then delete it,
					// ensuring it's not there any longer
					await addFileToContainer(
						currentContainer.id,
						'/tmp',
						'a.test',
						fileA,
					);
					await addFileToContainer(
						currentContainer.id,
						'/tmp',
						'b.test',
						fileB,
					);

					const container = new Container(
						dockerfileContent,
						context,
						currentContainer.id,
						docker,
					);

					const changedFiles = new FileUpdates({
						updated: [],
						deleted: ['a.test', 'b.test'],
						added: [],
					});

					const tasks = container.actionsNeeded(changedFiles);
					expect(tasks).to.have.length(1);

					await container.performActions(changedFiles, tasks);
					const files = await getDirectoryFromContainer(
						container.containerId,
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
					const context = path.join(__dirname, 'contexts', 'a');

					const container = new Container(
						dockerfileContent,
						context,
						currentContainer.id,
						docker,
					);
					const changedFiles = new FileUpdates({
						updated: [],
						deleted: [],
						added: ['a.test'],
					});

					const tasks = container.actionsNeeded(changedFiles);

					expect(tasks).to.have.length(1);

					await container.performActions(changedFiles, tasks);
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
	});
	describe('E2E', () => {
		it('should correctly handle directory copies', async () => {
			const context = path.join(__dirname, 'contexts', 'dir-copy');
			const dockerfileContent = await readFile(
				path.join(context, 'Dockerfile'),
				'utf8',
			);

			const containerId = await buildContext(context);

			const fileToChange = path.join(context, 'src', 'index.ts');
			const cachedFile = await readFile(fileToChange, 'utf8');

			try {
				const container = new Container(
					dockerfileContent,
					context,
					containerId,
					docker,
				);

				const newData = `${cachedFile}\nconsole.log('test')`;
				await fs.writeFile(fileToChange, newData);
				const changedFiles = new FileUpdates({
					updated: ['src/index.ts'],
					deleted: [],
					added: [],
				});

				const actions = container.actionsNeeded(changedFiles);
				expect(actions).to.have.length(1);

				expect(
					await (container as any).getOperations(['src/index.ts'], actions[0]),
				).to.deep.equal([
					{
						fromPath: 'src/index.ts',
						toPath: '/usr/src/app/src/index.ts',
					},
				]);

				await container.performActions(changedFiles, actions);

				const files = await getDirectoryFromContainer(
					container.containerId,
					'/usr/src/app',
				);

				expect(files)
					.to.have.property('app/src/index.ts')
					.that.has.property('data')
					.that.equals(newData);
			} finally {
				await fs.writeFile(fileToChange, cachedFile);
			}
		});
	});
});
