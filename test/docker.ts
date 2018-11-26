import * as Docker from 'dockerode';
import { fs } from 'mz';
import * as path from 'path';
import * as Url from 'url';

let dockerOpts: Docker.DockerOptions;
if (process.env.CIRCLECI != null) {
	let ca: string;
	let cert: string;
	let key: string;

	const certs = ['ca.pem', 'cert.pem', 'key.pem'].map(f =>
		path.join(process.env.DOCKER_CERT_PATH!, f),
	);
	[ca, cert, key] = certs.map(c => fs.readFileSync(c, 'utf-8'));
	const parsed = Url.parse(process.env.DOCKER_HOST!);

	dockerOpts = {
		host: 'https://' + parsed.hostname,
		port: parsed.port,
		ca,
		cert,
		key,
	};
} else {
	dockerOpts = { socketPath: '/var/run/docker.sock' };
}

export const docker = new Docker(dockerOpts);

export default docker;
