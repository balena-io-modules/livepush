import * as _ from 'lodash';
import { fs } from 'mz';
import * as Path from 'path';
import * as Stream from 'stream';
import * as tar from 'tar-stream';

import Container, { CommandExecutionContext } from './container';
import { RuntimeError } from './errors';

export interface LocalCopyTask {
	localSource: string;
	containerPath: string;
}

export function streamToBuffer(stream: Stream.Readable): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const bufs: Buffer[] = [];
		stream.on('data', d => bufs.push(d));
		stream.on('error', reject);
		stream.on('end', () => resolve(Buffer.concat(bufs)));
	});
}

export async function resolveFileLocations(
	files: string[],
	destination: string,
	container: Container,
): Promise<LocalCopyTask[]> {
	// First work out whether the destination is a directory or file
	const isDir = await container.pathIsDirectory(destination);

	if (!isDir) {
		// We should only be trying to copy a single file to the location
		// if the destination is not a directory, for example
		// COPY tsconfig.json tsconfig.json
		if (files.length > 1) {
			// TODO: Whilst it's correct to error out at this point, it
			// should really be handled at the dockerfile parsing level
			// Docker itself requires that COPY commands with more than
			// 2 arguments have a destination that ends with a / to make
			// it explicit
			throw new RuntimeError(
				`Unable to copy multiple files to a single file location`,
			);
		}

		// We know there's a single file, and it's being copied directly
		// to the destination
		return [
			{
				localSource: files[0],
				containerPath: destination,
			},
		];
	}

	return files.map(f => {
		// First we need to extract the filename itself, without the directory
		const name = Path.basename(f);
		const containerPath = Path.join(destination, name);
		return {
			localSource: f,
			containerPath,
		};
	});
}

export const hostPathIsDirectory = _.memoize(async (path: string) => {
	const stat = await fs.lstat(path);
	return stat.isDirectory();
});

export async function addFileToTarPack(
	pack: tar.Pack,
	path: string,
	destination: string,
): Promise<void> {
	const stat = await fs.stat(path);

	pack.entry({ name: destination, size: stat.size }, await fs.readFile(path));
}

export enum CommandExecutionArtifactType {
	EXIT_CODE,
	STDOUT_DATA,
	STDERR_DATA,
}

// tslint:disable
export type CommandExecutionArtifact =
	| {
			type: CommandExecutionArtifactType.EXIT_CODE;
			code: number;
	  }
	| {
			type:
				| CommandExecutionArtifactType.STDERR_DATA
				| CommandExecutionArtifactType.STDOUT_DATA;
			data: Buffer;
	  };
// tslint:enable

export async function waitForCommandCompletion(
	executionContext: CommandExecutionContext,
	cb: (artifact: CommandExecutionArtifact) => void,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		executionContext.stdout.on('data', data =>
			cb({ type: CommandExecutionArtifactType.STDOUT_DATA, data }),
		);
		executionContext.stderr.on('data', data =>
			cb({ type: CommandExecutionArtifactType.STDERR_DATA, data }),
		);
		executionContext.stdout.on('end', async () => {
			const inspect = await executionContext.exec.inspect();
			cb({
				type: CommandExecutionArtifactType.EXIT_CODE,
				code: inspect.ExitCode,
			});
			resolve();
		});
		executionContext.stderr.on('error', reject);
		executionContext.stdout.on('error', reject);
	});
}
