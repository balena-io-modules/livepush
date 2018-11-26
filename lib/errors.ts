import { TypedError } from 'typed-error';

export class DockerfileParseError extends TypedError {}
export class UnsupportedError extends TypedError {}
export class ContainerNotRunningError extends TypedError {}
export class InternalInconsistencyError extends TypedError {}
