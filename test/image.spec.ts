import 'mocha';

import { expect } from 'chai';
import * as fs from 'fs';
import * as _ from 'lodash';
import { Readable } from 'stream';
import * as tar from 'tar-stream';

import Image from '../lib/image';

function extractFilesFromArchive(
	tarStream: Readable,
	files: string[],
): Promise<{ [name: string]: string }> {
	const extract = tar.extract();
	const fileContent: { [name: string]: string } = {};
	return new Promise((resolve, reject) => {
		extract.on('entry', async (header, stream, next) => {
			if (_.includes(files, header.name)) {
				files = _.reject(files, name => name === header.name);
				const content = (await (Image as any).streamToBuffer(
					stream,
				)).toString();
				fileContent[header.name] = content;
			}
			next();
		});

		extract.on('error', reject);
		extract.on('finish', () => {
			if (files.length > 0) {
				reject(
					new Error(
						`Could not find all files in tar archive, missing: ${files}`,
					),
				);
			} else {
				resolve(fileContent);
			}
		});

		tarStream.pipe(extract);
	});
}

describe('Image utilities', () => {
	it('should correctly add a shim to a dockerfile', () => {
		const dockerfileContent = [
			'FROM image',
			'RUN command',
			'CMD command2',
		].join('\n');

		expect(Image.processDockerfile(dockerfileContent)).to.equal(
			[
				'FROM image',
				'RUN command',
				'CMD command2',
				'COPY .balena/livepush.sh /bin/livepush.sh',
				'RUN cp /bin/sh /bin/sh.real && cp /bin/livepush.sh /bin/sh',
			].join('\n'),
		);
	});

	it('should correctly add the shim to the build context', async () => {
		const context = fs.createReadStream(
			require.resolve('./test-data/context1/archive.tar'),
		);
		const newContext = await Image.addLivepushShim(context);

		return extractFilesFromArchive(newContext, [
			'./Dockerfile',
			'.balena/livepush.sh',
		]).then(files => {
			expect(files).to.deep.equal({
				'./Dockerfile': [
					'FROM image',
					'RUN command',
					'CMD command2',
					'COPY .balena/livepush.sh /bin/livepush.sh',
					'RUN cp /bin/sh /bin/sh.real && cp /bin/livepush.sh /bin/sh',
				].join('\n'),
				'.balena/livepush.sh': fs.readFileSync(
					require.resolve('../lib/shims/livepush.sh'),
					'utf8',
				),
			});
		});
	});

	describe('CMD commands', () => {
		it('Should correctly return non-array based CMD arguments', () => {
			const dockerfileContent = [
				'FROM image',
				'RUN command',
				'CMD command2',
			].join('\n');

			expect(Image.processDockerfile(dockerfileContent)).to.equal(
				[
					'FROM image',
					'RUN command',
					'CMD command2',
					'COPY .balena/livepush.sh /bin/livepush.sh',
					'RUN cp /bin/sh /bin/sh.real && cp /bin/livepush.sh /bin/sh',
				].join('\n'),
			);
		});

		it('should correctly change array based CMD arguments', () => {
			const dockerfileContent = [
				'FROM image',
				'RUN command',
				'CMD ["command2", "arg1", "arg2"]',
			].join('\n');

			expect(Image.processDockerfile(dockerfileContent)).to.equal(
				[
					'FROM image',
					'RUN command',
					'CMD ["/bin/sh", "-c", "command2 arg1 arg2"]',
					'COPY .balena/livepush.sh /bin/livepush.sh',
					'RUN cp /bin/sh /bin/sh.real && cp /bin/livepush.sh /bin/sh',
				].join('\n'),
			);
		});

		it('should correctly escape array based CMD arguments', () => {
			let dockerfileContent = [
				'FROM image',
				'RUN command',
				`CMD ["/bin/bash", "-c", "echo 'something else'"]`,
			].join('\n');

			expect(Image.processDockerfile(dockerfileContent)).to.equal(
				[
					'FROM image',
					'RUN command',
					`CMD ["/bin/sh", "-c", "/bin/bash -c echo 'something else'"]`,
					'COPY .balena/livepush.sh /bin/livepush.sh',
					'RUN cp /bin/sh /bin/sh.real && cp /bin/livepush.sh /bin/sh',
				].join('\n'),
			);

			dockerfileContent = [
				'FROM image',
				'RUN command',
				'CMD ["/bin/bash", "-c", "echo \'someth\\"ing else\'"]',
			].join('\n');

			expect(Image.processDockerfile(dockerfileContent)).to.equal(
				[
					'FROM image',
					'RUN command',
					`CMD ["/bin/sh", "-c", "/bin/bash -c echo 'someth\\"ing else'"]`,
					'COPY .balena/livepush.sh /bin/livepush.sh',
					'RUN cp /bin/sh /bin/sh.real && cp /bin/livepush.sh /bin/sh',
				].join('\n'),
			);
		});
	});
});
