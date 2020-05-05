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

## Webpack-dev-server/nodemon/my custom monitor is faster!

We agree! Special case programs can be extremely fast, and
livepush does not stop you from using them from within a
container. To enable this, you can use live directives:

### dev-cmd-live

A live cmd, provided by the `dev-cmd-live` direcitve, is the
command that gets executed in the container when this
container is running with livepush. It overrides the
existing `CMD` in the Dockerfile. This is achieved with a
preprocess step on the Dockerfile.

```Dockerfile
FROM node

COPY package*.json ./

RUN npm install

#dev-cmd-live=webpack-dev-server

COPY ./src src

RUN npm run build

COPY nginx.conf .

CMD nginx
```

The above is a webpack based project which also describes
how it should be run with livepush. Livepush will preprocess
this Dockerfile to be the equivalent of:

```Dockerfile
FROM node

COPY package*.json ./

RUN npm install

CMD webpack-dev-server

COPY ./src src

COPY nginx.conf .
```

Now when this container is executed, the main process will
be webpack-dev-server. Livepush will still copy in changed
source files. Livepush will optionally restart the container
based on a couple of rules:

- If the `COPY` step appears before the `#dev-cmd-live`
  directive, livepush will restart the container after
  copying in a file which is specified in that `COPY` step
- If the `COPY` step appears after the `#dev-cmd-live`
  directive, livepush will copy in the source file, but will
  not restart the container, and instead relies on the
  command specified by `#dev-cmd-live`

In this way, you can develop in a container, and have
blazing fast restart speeds via the program of your
choosing.

#### Multistage images

The behavior of a `#dev-cmd-live` in a multistage image is
as follows:

- When the directive appears in the last stage, it is as
  described above.
- When the directive appears in any other stage, livepush
  will ignore any stages that follow.

For example:

```Dockerfile
FROM node AS build

COPY package*.json ./

RUN npm install

#dev-cmd-live=webpack-dev-server

COPY ./src src

RUN npm run build

FROM node

COPY --from=build /dist/app.js .

RUN nginx
```

will be preprocessed to:

```Dockerfile
FROM node AS build

COPY package*.json ./

RUN npm install

CMD webpack-dev-server

COPY ./src src
```

## I need other resources in my container when developing!

For this, you can use two other directives:

- `#dev-copy=`
- `#dev-run=`

These directives take exactly the same kind of arguments
as their Dockerfile counterparts, but are only executed
when the container is running as part of a livepush
process.

Using these, it is possible to bring in any extra
dependencies that are useful when developing. For example,
you might choose to install webpack-dev-server using a
`dev-run` directive to avoid specifying it inside your package.json.

## Public API

### Livepush

#### init()

```typescript
static init({
	dockerfileContent: string | Buffer,
	context: string,
	containerId: string,
	stageImages: string[],
	docker: Dockerode,

	skipContainerRestart?: boolean,
}): Promise<Livepush>
```

Initialise a new Livepush instance with the dockerfile
content, the build context location on disk, the running
container ID, the IDs of the images created as part of a
possible multistage build (`[]` for single stage
dockerfiles) and an initialised handle to a docker daemon
via [Dockerode](https://github.com/apocas/dockerode).

The `skipContainerRestart` flag will stop livepush from
restarting the running container after performing a
livepush. This can be useful when the main process has some
kind of watch mode, for example `webpack-dev-server`, or
`node-supervisor`. Note that this is not necessary when
using the live directive.

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

- Add events for a livepush process starting and ending
