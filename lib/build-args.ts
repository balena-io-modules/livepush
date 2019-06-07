import * as Docker from 'dockerode';

export async function getBuildArgsForContainer(
	docker: Docker,
	containerId: string,
	argNames: string[],
): Promise<{ [name: string]: string }> {
	// First we find the image that this container was built
	// with
	const containerInspect = await docker.getContainer(containerId).inspect();
	const imageId = containerInspect.Image;

	// Get the history of this image
	const history = await docker.getImage(imageId).history();
	const entrypoint = (await docker.getImage(imageId).inspect()).Config
		.Entrypoint;
	console.log(Buffer.from(history[1].CreatedBy));

	return {};
}
