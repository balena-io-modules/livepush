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
			`Attempt to copy directory into non-directory destination from stage copy: destination: ${copy.dest}`,
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
				// We filter anything that's not a file or
				// directory. This is because there's things which
				// just dont make sense, like block devices. There's
				// also things like links which can break the build
				// because they either are linking to something that
				// appears later in the tar stream, or they link to
				// something that isn't being copied. The correct
				// way to handle this would be to ignore broken
				// links on the docker side, but the docker
				// implementation doesn't do this, so we'll have to
				// filter until we come up with a more elegant solution.
				if (headers.type !== 'file' && headers.type !== 'directory') {
					stream.on('end', next);
					stream.resume();
				} else {
					const name = resolveFileDestination(
						copy.source,
						copy.dest,
						headers.name,
					);

					pack.entry(
						{ ...headers, name },
						await streamToBuffer(stream),
						err => {
							if (err) {
								reject(err);
							}
							next();
						},
					);
				}
			},
		);
		extract.on('finish', () => {
			pack.finalize();
			resolve();
		});
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
	// TODO: Check return code
	const context = await source.executeCommand(
		Container.generateContainerCommand(`cat ${copy.source}`),
	);
	const permissionContext = await source.executeCommand(
		Container.generateContainerCommand(`stat -c %a ${copy.source}`),
	);

	// Build the buffer for the file
	const buf = await streamToBuffer(context.stdout);
	const permissions = (await streamToBuffer(permissionContext.stdout))
		.toString()
		.trim();

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
		pack.entry(
			{ name: destination, mode: parseInt(permissions, 8) },
			buf,
			(err?: Error) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			},
		);
	});
	pack.finalize();

	// Now we can send this file to the container
	await dest.addFilesToContainer(pack, '/');
}

export function resolveFileDestination(
	source: string,
	dest: string,
	pathInTar: string,
) {
	const sourceParts = source.split('/').filter(p => p !== '');
	let pathParts = pathInTar.split('/').filter(p => p !== '');

	if (sourceParts[sourceParts.length - 1] === pathParts[0]) {
		pathParts = pathParts.slice(1);
	}

	return path.join(dest, pathParts.join('/'));
}
