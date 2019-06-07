import { expect } from 'chai';

import * as Path from 'path';

import { buildContext, readFile } from './test-utils';
import docker from './docker';

import Livepush from '../lib';

describe.only('Build arguments', () => {
	it('should be able to re-apply build arguments when performing a livepush', async () => {
		const context = Path.join(__dirname, 'contexts', 'build-args', 'a');
		const dockerfileContent = await readFile(Path.join(context, 'Dockerfile'));
		let containerId: string | undefined;
		try {
			containerId = await buildContext(context, {
				buildargs: { TEST: 'test-string', TEST2: 'second-test asd' },
			});

			const livepush = await Livepush.init(
				dockerfileContent,
				context,
				containerId,
				[],
				docker,
			);

			let outputLines: string[] = [];
			livepush.on('commandOutput', ({ output }) => {
				outputLines.push(output.data.toString());
			});
			await livepush.performLivepush(['file'], []);

			expect(outputLines).to.have.length(1);
			expect(outputLines[0]).to.equal('test-string\n');
		} finally {
			// Make sure we remove everything
			await docker.getContainer(containerId).remove({ force: true });
			await docker
				.getImage('livepush-test-image:latest')
				.remove({ force: true });
		}
	});
});
