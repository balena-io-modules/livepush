import { expect } from 'chai';

import { fs } from 'mz';
import * as path from 'path';

import Livepush, { Dockerfile } from '../lib';

describe('Instance construction', () => {
	let dockerfileContent: Buffer;

	before(async () => {
		dockerfileContent = await fs.readFile(
			path.join(__dirname, 'dockerfiles', 'single-stage', 'Dockerfile.a'),
		);
	});

	it('should be constructed with a dockerfile content', async () => {
		const livepush = await Livepush.init({
			dockerfileContent,
			context: '.',
			stageImages: [],
			docker: {} as any,
			containerId: 'id',
		});

		expect(livepush.dockerfile)
			.to.have.property('stages')
			.that.has.length(1);

		expect(livepush.livepushNeeded(['test'], [])).to.equal(false);
	});

	it('should be constructed with an instanced Dockerfile class', async () => {
		const dockerfile = new Dockerfile(dockerfileContent);

		const livepush = await Livepush.init({
			dockerfile,
			context: '.',
			stageImages: [],
			docker: {} as any,
			containerId: 'id',
		});

		expect(livepush.dockerfile)
			.to.have.property('stages')
			.that.has.length(1);

		expect(livepush.livepushNeeded(['test'], [])).to.equal(false);
	});
});
