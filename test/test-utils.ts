import { expect } from 'chai';

import * as _ from 'lodash';
import { fs } from 'mz';
import * as tarFs from 'tar-fs';
import * as tar from 'tar-stream';
import docker from './docker';

import * as Dockerode from 'dockerode';

import Container from '../lib/container';
import { streamToBuffer } from '../lib/util';

export interface FileData {
	[name: string]: {
		header: tar.Headers;
		name: string;
		data: string;
	};
}

export async function getDirectoryFromContainer(
	containerId: string,
	path: string,
): Promise<FileData> {
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
}

export async function addFileToContainer(
	containerId: string,
	filename: string,
	content: string,
): Promise<void> {
	const command = Container.generateContainerCommand(
		`printf '${content}' > ${filename}`,
	);
	const returnCode = await ((await Container.fromContainerId(
		'',
		docker,
		containerId,
	)) as any).executeCommandDetached(command);

	expect(returnCode).to.equal(0);
}

export const readFile = _.memoize(fs.readFile);

export async function buildContext(
	context: string,
	extraOpts: {},
): Promise<string> {
	console.log('Building context:', context);
	const buildStream = await docker.buildImage(tarFs.pack(context), {
		t: 'livepush-test-image:latest',
		...extraOpts,
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
}

export async function createImageWithFile(
	baseImage: string,
	filename: string,
	content: string,
) {
	const dockerContainer = await docker.createContainer({
		Image: baseImage,
		Tty: true,
		Cmd: ['/bin/sh'],
	});
	await dockerContainer.start();
	const container = await Container.fromContainerId(
		'',
		docker,
		dockerContainer.id,
	);

	await addFileToContainer(container.containerId, filename, content);

	const { Id } = await docker
		.getContainer(dockerContainer.id)
		.commit({ repo: 'livepush-test-image', tag: filename.replace(/\//g, '') });

	await dockerContainer.remove({ force: true });

	return Id;
}
