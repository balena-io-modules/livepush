import * as _ from 'lodash';
import * as path from 'path';
import { Readable } from 'stream';
import * as tar from 'tar-stream';

import { StageCopy } from './action-group';
import { Container } from './container';
import { InternalInconsistencyError } from './errors';
import { streamToBuffer } from './util';

export async function copyToStage(
	source: Container,
	dest: Container,
	copy: StageCopy,
) {
	if (await source.pathIsDirectory(copy.source)) {
		await copyDirToStage(source, dest, copy);
	} else {
		await copyFileToStage(source, dest, copy);
	}
}

async function copyDirToStage(
	source: Container,
	dest: Container,
	copy: StageCopy,
) {
	if (!(await dest.pathIsDirectory(copy.dest))) {
		throw new InternalInconsistencyError(
			`Attempt to copy directory into non-directory destination from stage copy: destination: ${
				copy.dest
			}`,
		);
	}

	// Get everything from the directory of the source container
	const sourceStream = await source.fetchPathFromContainer(copy.source);

	// Now we need to go through, creating a new tar stream, which
	// sets up the paths based relative to root

	const extract = tar.extract();
	const pack = tar.pack();

	await new Promise((resolve, reject) => {
		extract.on(
			'entry',
			async (headers: tar.Headers, stream: Readable, next: () => void) => {
				let pathName = headers.name;
				if (path.isAbsolute(copy.source)) {
					pathName = `/${pathName}`;
				}
				const toAppend = path.relative(copy.source, pathName);

				pack.entry(
					{ ...headers, name: path.join(copy.dest, toAppend) },
					await streamToBuffer(stream),
					err => {
						if (err) {
							reject(err);
						}
						next();
					},
				);

				extract.on('finish', () => {
					pack.finalize();
					resolve();
				});
			},
		);
		sourceStream.pipe(extract);
	});

	await dest.addFilesToContainer(pack, '/');
}

async function copyFileToStage(
	source: Container,
	dest: Container,
	copy: StageCopy,
) {
	// Rather than fetch an entire directory from docker,
	// we instead just read the file directly
	const context = await source.executeCommand(
		Container.generateContainerCommand(`cat ${copy.source}`),
	);

	// Build the buffer for the file
	const buf = await streamToBuffer(context.stdout);
	// TODO: Check return code

	// Now generate a tar stream with the correct structure
	let destination = (await dest.pathIsDirectory(copy.dest))
		? `${copy.dest}/${path.basename(copy.source)}`
		: copy.dest;

	if (!_.startsWith(destination, '/')) {
		throw new InternalInconsistencyError(
			`Attempt to copy non-absolute file from stage: destination: ${destination}`,
		);
	}
	// Stip the first /
	destination = destination.replace('/', '');

	const pack = tar.pack();
	await new Promise((resolve, reject) => {
		pack.entry({ name: destination }, buf, (err?: Error) => {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	});
	pack.finalize();

	// Now we can send this file to the container
	await dest.addFilesToContainer(pack, '/');
}
