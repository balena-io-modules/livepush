import * as _ from 'lodash';
import { fs } from 'mz';
import { Readable } from 'stream';
import * as tar from 'tar-stream';
import { DockerfileParseError } from './errors';

export class Image {
	public static shimContent: Buffer;

	public static async addLivepushShim(
		buildContext: Readable,
		dockerfileRegex = /^(?:\.\/)?Dockerfile$/,
	): Promise<Readable> {
		const extract = tar.extract();
		const pack = tar.pack();

		await Image.loadShim();
		return new Promise<Readable>((resolve, reject) => {
			extract.on('entry', async (header, stream, next) => {
				const errHandle = (err: Error) => {
					if (err != null) {
						reject(err);
					} else {
						next();
					}
				};

				if (dockerfileRegex.test(header.name)) {
					// We need to process the dockerfile to add the COPY instruction for the shim
					const dockerfileContent = Image.processDockerfile(
						(await Image.streamToBuffer(stream)).toString(),
					);
					pack.entry(header, dockerfileContent, errHandle);
				} else {
					const entry = pack.entry(header, errHandle);
					stream.pipe(entry);
				}
			});

			extract.on('error', reject);
			extract.on('finish', () => {
				// Add the shim to the build context
				pack.entry(
					{ name: '.balena/livepush.sh', size: Image.shimContent.length },
					Image.shimContent,
					err => {
						if (err != null) {
							reject(err);
						} else {
							pack.finalize();
							resolve(pack);
						}
					},
				);
			});

			buildContext.pipe(extract);
		});
	}

	public static processDockerfile(dockerfileContent: string): string {
		return dockerfileContent
			.split(/\r?\n/)
			.filter(l => l.length > 0)
			.concat([
				'COPY .balena/livepush.sh /bin/livepush.sh',
				'RUN cp /bin/sh /bin/sh.real && cp /bin/livepush.sh /bin/sh',
			])
			.join('\n');
	}

	private static streamToBuffer(
		stream: NodeJS.ReadableStream,
	): Promise<Buffer> {
		return new Promise<Buffer>((resolve, reject) => {
			const chunks: Buffer[] = [];
			stream.on('data', chunks.push.bind(chunks));
			stream.on('error', reject);
			stream.on('end', () => {
				resolve(Buffer.concat(chunks));
			});
		});
	}

	private static loadShim = _.once(async () => {
		Image.shimContent = await fs.readFile(
			require.resolve('./shims/livepush.sh'),
		);
	});
}

export default Image;
