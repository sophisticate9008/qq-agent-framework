import { PrivateJsonStorageError } from '../storage/private-json.ts'

/** HTTP compatibility error; storage services use PrivateJsonStorageError directly. */
export class AdminRequestError extends PrivateJsonStorageError {}
