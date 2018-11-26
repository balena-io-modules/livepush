import * as Stream from 'stream';

export function streamToBuffer(stream: Stream.Readable): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const bufs: Buffer[] = [];
		stream.on('data', d => bufs.push(d));
		stream.on('error', reject);
		stream.on('end', () => resolve(Buffer.concat(bufs)));
	});
}
