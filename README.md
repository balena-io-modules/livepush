# Livepush

Push code to your containers - live!

Given a running container, this module will sync over any
changes in the filesystem and perform the docker build
within the container.

Note this module is not intended to be used directly, and
instead provides a publc API for different frontends.

A notable frontend is
[balena-cli](https://github.com/balena-io/balena-cli) where
it is used for live updates of local mode devices.

## An example

Given the following Dockerfile:

```Dockerfile
FROM debian

WORKDIR /usr/src/app

COPY package.json .

RUN npm install

COPY src/ src/

CMD node src/app.js
```

A change made to the package.json, for example
`npm install --save express` will invalidate every step from
`COPY package.json .` and cause a rebuild from there.

That would copy the new package.json into the container, run
`npm install`, and move to the next stop. At the next step,
livepush would try to calculate of the files which have
changed, which should be synced into the container. Because
`package.json` is not part of the `src/` directory, nothing
will happen. After this the container will be restarted and
the `CMD` step will run again.

## Public API

### Livepush

#### init()

```typescript
static init(
	dockerfileContent: string | Buffer,
	context: string,
	containerId: string,
	stageImages: string[],
	docker: Dockerode,
): Promise<Livepush>
```

Initialise a new Livepush instance with the dockerfile
content, the build context location on disk, the running
container ID, the IDs of the images created as part of a
possible multistage build (`[]` for single stage
dockerfiles) and an initialised handle to a docker daemon
via [Dockerode](https://github.com/apocas/dockerode).

#### performLivepush

```typescript
performLivepush(
	addedOrUpdated: string[],
	deleted: string[],
): Promise<void> {
```

Provide the livepush instance with a list of files relative
to the build context, and livepush will perfom any tasks
necessary to get this code running remotely.

If a livepush process is already running, this will be
cancelled, and the new one will start when the last executed
command finishes (docker does not provide a way to cancel a
command which is started by the api).

Can throw:

- `ContainerNotRunningError` - This is thrown when livepush
  tries to perform an action on any container that is no
  longer running.

#### cleanupIntermediateContainers

```typescript
cleanupIntermediateContainers();
```

For each stage in the Dockerfile which is not the final
stage, a container is created, to provide an environment in
which to copy any files and execute tasks. This function
will remove these containers. Note that once these
containers are removed, if `performLivepush` is called
again, it will throw a `ContainerNotRunningError`.

#### Events

The livepush instance will emit events whilst performing a
livepush. Note that these events are fully typed when using Typescript.

##### `commandExecute`

This function is called with an object `{ stageIdx: number, command: string }` and is called whenever a command is executed within a container. The
`stageIdx` parameter represents the stage in the Dockerfile that this
executed in.

##### `commandOutput`

Whenever a command outputs data, this event will be called. The argument has the form:
`{ stageIdx: number; output: CommandOutput }`
where `CommandOutput` has the structure:

```typescript
{
	data: Buffer;
	isStderr: boolean;
}
```

##### `commandReturn`

When a command returns, this event will be called with the
following argument: `{ stageIdx: number; returnCode: number; command: string }`

##### `containerRestart`

When a container is restarted this event is emitted with
argument `{ contianerId: string }`.

##### `cancel`

This event is emitted when an ongoing livepush process is cancelled.

## Planned additions

- Add the ability to not restart the container after a
  livepush has occurred. This would be useful in combination
  with source watching programs such as `node-supervisor`.
- Add events for a livepush process starting and ending
