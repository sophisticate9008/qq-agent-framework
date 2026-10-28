import type { PluginRuntimeServices } from './plugin-runtime.ts';
import { validExtensionMetadata } from '../contracts/extension-metadata.ts';
import type { OneBotTransportOptions } from '../adapters/onebot.ts';
import type { FeatureDefinition } from '../core/types.ts';
import { FrameworkError, assert, errorCode, identifier, isRecord, snapshot } from '../core/values.ts';
import type { BridgeHostOptions, createBridgeHost } from './bridge.ts';
import { withDeadline } from './deadlines.ts';
import type { NativeMessageSourceReader } from './native-message-sources.ts';
import { createLifecycleHooks, type LifecycleHookDefinition } from './lifecycle-hooks.ts';
import type { ControlCommandDefinition } from './control-commands.ts';
import type { NativePackageDefinition, NativePackages } from './native-packages.ts';
import { createNativePackageBindings } from './native-package-bindings.ts';
import { validatePackageConfigurationContribution, type PackageConfigurationContribution } from './package-configuration.ts';
import type { NativePackageContentIdentity } from '../contracts/native-package-content.ts';
import { digest } from './data.ts';
import { composeAgentInputPreparation } from './input-preparation.ts';
import type { createReloadableExtensionRegistry } from './reloadable-extensions.ts';

export type NativeBootstrapHost = ReturnType<typeof createBridgeHost>;
export interface NativeBootstrapManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 1;
}
export interface NativeBootstrapContext {
  readonly runtime?: PluginRuntimeServices;
  /** Registered, independently replaceable implementations owned by this runtime. */
  readonly extensions?: ReturnType<typeof createReloadableExtensionRegistry>;
  readonly directory: string;
  readonly store: BridgeHostOptions['store'];
  readonly context: BridgeHostOptions['context'];
  readonly persona: string;
  readonly signal: AbortSignal;
  readonly messageSources?: Readonly<NativeMessageSourceReader>;
}
export type NativeBootstrapBridgeOptions = Pick<BridgeHostOptions,
  'effectAdapters' | 'eventValidators' | 'routeIncoming' | 'agentInputPreparation' | 'agentMessagePreparation'>;
export type NativeBootstrapOneBotOptions = Pick<OneBotTransportOptions, 'resolveAsset' | 'forward'>;
export interface NativeBootstrapExtension extends NativeBootstrapBridgeOptions {
  readonly lifecycleHooks?: readonly LifecycleHookDefinition[];
  readonly packages?: readonly NativePackageDefinition[];
  readonly features?: readonly FeatureDefinition[];
  readonly onebot?: NativeBootstrapOneBotOptions;
  start?(host: NativeBootstrapHost, signal: AbortSignal): void | Promise<void>;
  stop?(host: NativeBootstrapHost, signal: AbortSignal): void | Promise<void>;
}
export interface NativeBootstrapDefinition {
  readonly packageConfigurations?: readonly PackageConfigurationContribution[];
  readonly manifest: NativeBootstrapManifest;
  readonly controlCommands?: readonly ControlCommandDefinition[];
  readonly lifecycleHooks?: readonly LifecycleHookDefinition[];
  create(context: Readonly<NativeBootstrapContext>): NativeBootstrapExtension | Promise<NativeBootstrapExtension>;
}
export interface NativeBootstrapMetadata {
  readonly manifest: NativeBootstrapManifest;
  readonly codeFingerprint: string;
  readonly contentIdentity?: NativePackageContentIdentity;
  readonly trust: 'trusted-operator-code';
  readonly sandboxed: false;
  readonly requiresSeparateAuthorization: true;
}
export interface LoadedNativeBootstrap {
  readonly verifyContent?: (signal: AbortSignal) => Promise<void>;
  readonly packageConfigurations?: readonly PackageConfigurationContribution[];
  readonly metadata: Readonly<NativeBootstrapMetadata>;
  readonly controlCommands?: readonly ControlCommandDefinition[];
  readonly lifecycleHooks?: readonly LifecycleHookDefinition[];
  create(context: Readonly<NativeBootstrapContext>): NativeBootstrapExtension | Promise<NativeBootstrapExtension>;
}
export type NativeBootstrapState = 'prepared' | 'installed' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'unknown';

const pendingCreates = new WeakSet<LoadedNativeBootstrap>();
const unsettledMounts = new WeakMap<LoadedNativeBootstrap, () => boolean>();
const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

function plain(input: unknown, keys?: readonly string[]): void {
  assert(isRecord(input) && [Object.prototype, null].includes(Object.getPrototypeOf(input)),
    'INVALID_NATIVE_BOOTSTRAP', 'Bootstrap declarations must be plain objects.');
  assert(Reflect.ownKeys(input).every(key => typeof key === 'string' && (!keys || keys.includes(key))
    && Object.getOwnPropertyDescriptor(input, key)?.enumerable
    && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value')),
  'INVALID_NATIVE_BOOTSTRAP', 'Bootstrap declarations cannot contain accessors or unexpected fields.');
}

function boundedNames(input: unknown, limit: number): asserts input is readonly string[] {
  assert(Array.isArray(input) && input.length <= limit && Object.keys(input).length === input.length
    && input.every(identifier) && new Set(input).size === input.length,
  'INVALID_NATIVE_BOOTSTRAP', 'Bootstrap declarations need bounded distinct names.');
}

function validateBootstrapPackageConfigurations(input: readonly PackageConfigurationContribution[]) {
  assert(Array.isArray(input) && input.length <= 128 && Object.keys(input).length === input.length,
    'INVALID_NATIVE_BOOTSTRAP', 'Bootstrap configuration declarations must be bounded.');
  const entries = input.map(validatePackageConfigurationContribution);
  assert(new Set(entries.map(entry => entry.descriptor.id)).size === entries.length,
    'PACKAGE_CONFIGURATION_DUPLICATE', 'Bootstrap configuration declarations must have distinct IDs.');
  return Object.freeze(entries);
}

function validateBootstrapPackageConfigurationReferences(configurations: readonly PackageConfigurationContribution[], packages: readonly NativePackageDefinition[]) {
  const declared = validateBootstrapPackageConfigurations(configurations);
  const seen = new Set<string>();
  for (const definition of packages) {
    const legacy = (definition.configurations ?? []).map(validatePackageConfigurationContribution);
    const ids = definition.configurationIds ?? legacy.map(item => item.descriptor.id);
    assert(Array.isArray(ids) && ids.length <= 128 && ids.every(identifier) && new Set(ids).size === ids.length,
      'NATIVE_BOOTSTRAP_CONFIGURATION_UNDECLARED', 'Package configuration references must be bounded and distinct.');
    for (const id of ids) {
      const entry = declared.find(item => item.descriptor.id === id);
      assert(entry && entry.descriptor.owner === definition.manifest.id && !seen.has(id),
        'NATIVE_BOOTSTRAP_CONFIGURATION_UNDECLARED', 'Runtime configuration references must match the loaded owner declaration.');
      seen.add(id);
    }
    for (const contribution of legacy) {
      const entry = declared.find(item => item.descriptor.id === contribution.descriptor.id);
      assert(entry && ids.includes(entry.descriptor.id) && entry.validate === contribution.validate && entry.migrate === contribution.migrate
        && digest(entry.descriptor) === digest(contribution.descriptor) && digest(entry.defaults) === digest(contribution.defaults),
      'NATIVE_BOOTSTRAP_CONFIGURATION_MISMATCH', 'Runtime schema declarations must match the loaded configuration contract.');
    }
  }
  assert(seen.size === declared.length, 'NATIVE_BOOTSTRAP_CONFIGURATION_UNDECLARED', 'Every loaded configuration must belong to a declared runtime package.');
}

export function defineNativeBootstrap(input: NativeBootstrapDefinition): Readonly<NativeBootstrapDefinition> {
  plain(input, ['manifest', 'create', 'controlCommands', 'lifecycleHooks', 'packageConfigurations']);
  plain(input.manifest, ['id', 'version', 'apiVersion']);
  assert(identifier(input.manifest.id) && input.manifest.apiVersion === 1
    && typeof input.manifest.version === 'string' && input.manifest.version.length <= 100
    && versionPattern.test(input.manifest.version) && typeof input.create === 'function',
  'INVALID_NATIVE_BOOTSTRAP', 'A versioned bootstrap manifest and create function are required.');
  const packageConfigurations = validateBootstrapPackageConfigurations(input.packageConfigurations ?? []);
  const hooks = input.lifecycleHooks ?? [];
  createLifecycleHooks(hooks).close();
  const commands = input.controlCommands ?? [];
  assert(Array.isArray(commands) && commands.length <= 32, 'INVALID_NATIVE_BOOTSTRAP', 'Control command registration is bounded.');
  const commandIds = new Set<string>();
  const controlCommands = commands.map((command: ControlCommandDefinition) => {
    plain(command, ['id', 'matches', 'handle', 'replyTexts']);
    assert(identifier(command.id) && !commandIds.has(command.id) && typeof command.matches === 'function'
      && typeof command.handle === 'function' && (command.replyTexts === undefined || Array.isArray(command.replyTexts)
        && command.replyTexts.length <= 32 && command.replyTexts.every((text: unknown) => typeof text === 'string'
          && text.trim().length > 0 && text.length <= 1000)), 'INVALID_NATIVE_BOOTSTRAP', 'Control commands need fixed handlers and reply templates.');
    commandIds.add(command.id);
    return Object.freeze({ ...command, ...(command.replyTexts === undefined ? {} : { replyTexts: Object.freeze([...command.replyTexts]) }) });
  });
  return Object.freeze({ manifest: snapshot(input.manifest), create: input.create, packageConfigurations,
    controlCommands: Object.freeze(controlCommands), lifecycleHooks: Object.freeze([...hooks]) });
}

function extension(input: NativeBootstrapExtension): Readonly<NativeBootstrapExtension> {
  plain(input, ['packages', 'features', 'effectAdapters', 'eventValidators', 'routeIncoming', 'agentInputPreparation', 'agentMessagePreparation', 'onebot', 'start', 'stop', 'lifecycleHooks']);
  const packageInput = input.packages ?? [];
  assert(Array.isArray(packageInput) && packageInput.length <= 128 && Object.keys(packageInput).length === packageInput.length,
    'INVALID_NATIVE_BOOTSTRAP', 'A bootstrap may declare at most 128 packages.');
  const packages = packageInput.map((definition: NativePackageDefinition) => {
    plain(definition, ['manifest', 'content', 'configurations', 'configurationIds', 'prepare', 'migrate', 'install', 'recover', 'start', 'drain', 'dispose']);
    plain(definition.manifest, ['schema', 'id', 'version', 'displayName', 'description', 'toolNames', 'stateSchemaVersion', 'dependencies', 'provides', 'requires', 'contributions']);
    return Object.freeze({ ...definition, manifest: snapshot(definition.manifest) });
  });
  const lifecycleHooks = input.lifecycleHooks ?? [];
  const hookValidation = createLifecycleHooks(lifecycleHooks);
  hookValidation.close();
  const features = input.features ?? [];
  assert(Array.isArray(features) && features.length <= 64 && Object.keys(features).length === features.length,
    'INVALID_NATIVE_BOOTSTRAP', 'A bootstrap may install at most 64 features.');
  const ids = new Set<string>();
  const copiedFeatures = features.map(feature => {
    plain(feature, ['id', 'version', 'displayName', 'description', 'toolNames', 'apiVersion', 'capabilities', 'subscriptions', 'setup']);
    assert(validExtensionMetadata(feature) && identifier(feature.id) && feature.id !== 'agent-relay' && !ids.has(feature.id)
      && typeof feature.version === 'string' && feature.version.length <= 100 && versionPattern.test(feature.version)
      && feature.apiVersion === 1 && typeof feature.setup === 'function',
    'INVALID_NATIVE_BOOTSTRAP', 'Bootstrap features must have distinct non-reserved versioned identities.');
    boundedNames(feature.capabilities, 128);
    boundedNames(feature.subscriptions, 128);
    ids.add(feature.id);
    return Object.freeze({ ...feature, capabilities: Object.freeze([...feature.capabilities]), subscriptions: Object.freeze([...feature.subscriptions]) });
  });
  const effects = input.effectAdapters ?? {};
  const validators = input.eventValidators ?? {};
  plain(effects);
  plain(validators);
  assert(Object.keys(effects).length <= 128 && Object.keys(validators).length <= 128,
    'INVALID_NATIVE_BOOTSTRAP', 'Bootstrap registries must be bounded.');
  const copiedEffects: NonNullable<BridgeHostOptions['effectAdapters']> = {};
  const copiedValidators: NonNullable<BridgeHostOptions['eventValidators']> = {};
  for (const [name, adapter] of Object.entries(effects)) {
    assert(identifier(name) && !name.startsWith('agent.') && !['messaging.send', 'messaging.forward', 'model.respond'].includes(name),
      'INVALID_NATIVE_BOOTSTRAP', 'Bootstrap effects cannot replace reserved capabilities.');
    plain(adapter, ['execute']);
    assert(typeof adapter.execute === 'function', 'INVALID_NATIVE_BOOTSTRAP', 'An effect execute function is required.');
    copiedEffects[name] = Object.freeze({ execute: adapter.execute });
  }
  for (const [name, validator] of Object.entries(validators)) {
    assert(identifier(name) && !name.startsWith('agent.') && !['message.received', 'trigger.fired'].includes(name)
      && typeof validator === 'function', 'INVALID_NATIVE_BOOTSTRAP', 'A non-reserved event validator is required.');
    copiedValidators[name] = validator;
  }
  for (const hook of [input.routeIncoming, input.start, input.stop]) {
    assert(hook === undefined || typeof hook === 'function', 'INVALID_NATIVE_BOOTSTRAP', 'Bootstrap hooks must be functions.');
  }
  let preparation = input.agentMessagePreparation;
  if (preparation !== undefined) {
    plain(preparation, ['capabilities', 'prepare']);
    boundedNames(preparation.capabilities, 32);
    assert(typeof preparation.prepare === 'function', 'INVALID_NATIVE_BOOTSTRAP', 'A message preparation function is required.');
    preparation = Object.freeze({ capabilities: Object.freeze([...preparation.capabilities]), prepare: preparation.prepare });
  }
  let inputPreparation = input.agentInputPreparation;
  if (inputPreparation !== undefined) {
    plain(inputPreparation, ['capabilities', 'prepare']);
    boundedNames(inputPreparation.capabilities, 32);
    assert(typeof inputPreparation.prepare === 'function', 'INVALID_NATIVE_BOOTSTRAP', 'An input preparation function is required.');
    inputPreparation = Object.freeze({ capabilities: Object.freeze([...inputPreparation.capabilities]), prepare: inputPreparation.prepare });
  }
  let onebot = input.onebot;
  if (onebot !== undefined) {
    plain(onebot, ['resolveAsset', 'forward']);
    assert(onebot.resolveAsset === undefined || typeof onebot.resolveAsset === 'function',
      'INVALID_NATIVE_BOOTSTRAP', 'A controlled OneBot resource resolver is required.');
    if (onebot.forward !== undefined) {
      plain(onebot.forward, ['senderId', 'senderName', 'group', 'private']);
      assert(typeof onebot.forward.senderId === 'string' && /^[1-9]\d{0,19}$/.test(onebot.forward.senderId)
        && typeof onebot.forward.senderName === 'string' && onebot.forward.senderName.length > 0 && onebot.forward.senderName.length <= 128
        && [undefined, true, false].includes(onebot.forward.group) && [undefined, true, false].includes(onebot.forward.private),
      'INVALID_NATIVE_BOOTSTRAP', 'Forward messages need explicit trusted sender settings.');
    }
    onebot = Object.freeze({ ...onebot, ...(onebot.forward === undefined ? {} : { forward: snapshot(onebot.forward) }) });
  }
  return Object.freeze({ ...input, packages: Object.freeze(packages), lifecycleHooks: Object.freeze([...lifecycleHooks]), features: Object.freeze(copiedFeatures), effectAdapters: Object.freeze(copiedEffects),
    eventValidators: Object.freeze(copiedValidators), ...(preparation === undefined ? {} : { agentMessagePreparation: preparation }),
    ...(inputPreparation === undefined ? {} : { agentInputPreparation: inputPreparation }),
    ...(onebot === undefined ? {} : { onebot }) });
}

export async function createNativeBootstrapMount({ bootstrap, context, timeoutMs = 10000 }:
  { bootstrap: LoadedNativeBootstrap; context: NativeBootstrapContext; timeoutMs?: number }) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 300000,
    'INVALID_NATIVE_BOOTSTRAP', 'A finite bootstrap lifecycle deadline is required.');
  assert(context.signal instanceof AbortSignal && typeof bootstrap.create === 'function'
    && /^[a-f0-9]{64}$/.test(bootstrap.metadata.codeFingerprint), 'INVALID_NATIVE_BOOTSTRAP', 'A verified bootstrap and lifecycle signal are required.');
  assert(!pendingCreates.has(bootstrap) && !unsettledMounts.get(bootstrap)?.(),
    'NATIVE_BOOTSTRAP_PENDING_UNKNOWN', 'Earlier bootstrap work remains unresolved.');
  const controller = new AbortController();
  const lifetime = AbortSignal.any([context.signal, controller.signal]);
  let created: Readonly<NativeBootstrapExtension>;
  try {
    created = await withDeadline({ signal: lifetime, timeoutMs, code: 'NATIVE_BOOTSTRAP_CREATE_TIMEOUT_UNKNOWN', run(signal) {
      pendingCreates.add(bootstrap);
      const raw = Promise.resolve().then(() => bootstrap.create(Object.freeze({ ...context, signal: AbortSignal.any([lifetime, signal]) }))).then(extension);
      raw.then(() => pendingCreates.delete(bootstrap), () => pendingCreates.delete(bootstrap));
      return raw;
    } });
  } catch (error) {
    controller.abort();
    const code = errorCode(error, 'NATIVE_BOOTSTRAP_CREATE_FAILED');
    throw new FrameworkError(code === 'OPERATION_ABORTED_UNKNOWN' ? 'NATIVE_BOOTSTRAP_CREATE_ABORTED_UNKNOWN' : code,
      'Bootstrap preparation did not complete safely.');
  }
  const packageDefinitions = Object.freeze([...(created.packages ?? [])]);
  let packageBindings: ReturnType<typeof createNativePackageBindings>;
  let preparations: Parameters<typeof composeAgentInputPreparation>[0];
  try {
    validateBootstrapPackageConfigurationReferences(bootstrap.packageConfigurations ?? [], packageDefinitions);
    packageBindings = createNativePackageBindings({ definitions: packageDefinitions, signal: lifetime });
    const packageBridge = packageBindings.bridgeOptions;
    for (const name of Object.keys(packageBridge.effectAdapters)) assert(!created.effectAdapters?.[name],
      'NATIVE_PACKAGE_CONTRIBUTION_DUPLICATE', 'A package effect conflicts with a bootstrap effect.');
    for (const name of Object.keys(packageBridge.eventValidators)) assert(!created.eventValidators?.[name],
      'NATIVE_PACKAGE_CONTRIBUTION_DUPLICATE', 'A package validator conflicts with a bootstrap validator.');
    for (const definition of packageDefinitions) for (const item of definition.manifest.contributions) {
      if (item.kind === 'feature') assert(!created.features?.some(feature => feature.id === item.id),
        'NATIVE_PACKAGE_CONTRIBUTION_DUPLICATE', 'A package feature conflicts with a bootstrap feature.');
    }
    preparations = [
      ...(created.agentInputPreparation ? [{ id: 'bootstrap-legacy', order: 0, ...created.agentInputPreparation }] : []),
      ...(packageBridge.agentInputPreparation ? [{ id: 'bootstrap-packages', order: 1, ...packageBridge.agentInputPreparation }] : [])
    ];
  } catch (error) { controller.abort(); throw error; }
  const packageBridge = packageBindings.bridgeOptions;
  let state: NativeBootstrapState = 'prepared';
  let installedHost: NativeBootstrapHost | undefined;
  let pendingStart = false;
  let pendingStop = false;
  let rawStart: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const installed: string[] = [];
  unsettledMounts.set(bootstrap, () => pendingStart || pendingStop || ['prepared', 'installed', 'starting', 'running', 'stopping'].includes(state));

  function sameHost(host: NativeBootstrapHost) {
    assert(host === installedHost, 'NATIVE_BOOTSTRAP_HOST_MISMATCH', 'Bootstrap lifecycle cannot change hosts.');
  }
  function failure(error: unknown, fallback: string) {
    const failureCode = errorCode(error, fallback);
    const code = failureCode === 'OPERATION_ABORTED_UNKNOWN' ? fallback.replace(/_FAILED$/, '_ABORTED_UNKNOWN') : failureCode;
    state = code.includes('UNKNOWN') ? 'unknown' : 'failed';
    return new FrameworkError(code, 'Bootstrap lifecycle did not complete safely.');
  }
  return Object.freeze({
    packageDefinitions,
    lifecycleHooks: created.lifecycleHooks ?? Object.freeze([]),
    bridgeOptions: Object.freeze({ effectAdapters: Object.freeze({ ...created.effectAdapters, ...packageBridge.effectAdapters }),
      eventValidators: Object.freeze({ ...created.eventValidators, ...packageBridge.eventValidators }),
      ...(created.routeIncoming === undefined ? {} : { routeIncoming: created.routeIncoming }),
      ...(preparations.length === 0 ? {} : { agentInputPreparation: composeAgentInputPreparation(preparations) }),
      ...(created.agentMessagePreparation === undefined ? {} : { agentMessagePreparation: created.agentMessagePreparation }) }),
    onebotOptions: created.onebot ?? Object.freeze({}),
    abandonPrepared() {
      assert(state === 'prepared' && installedHost === undefined && installed.length === 0
        && !pendingStart && !pendingStop && starting === undefined && stopping === undefined,
      'NATIVE_BOOTSTRAP_ABANDON_DENIED', 'Only an uninstalled prepared bootstrap can be abandoned.');
      controller.abort();
      state = 'stopped';
    },
    async install(host: NativeBootstrapHost) {
      assert(state === 'prepared' && !lifetime.aborted, 'NATIVE_BOOTSTRAP_INSTALL_DENIED', 'Bootstrap features can only be installed once.');
      installedHost = host;
      try {
        for (const feature of created.features ?? []) { host.engine.install(feature); installed.push(feature.id); }
        state = 'installed';
      } catch (error) {
        state = 'failed';
        for (const id of [...installed].reverse()) await host.engine.uninstall(id);
        throw failure(error, 'NATIVE_BOOTSTRAP_INSTALL_FAILED');
      }
    },
    async bindPackages(host: NativeBootstrapHost, packages: NativePackages) {
      sameHost(host);
      assert(state === 'installed' && !lifetime.aborted, 'NATIVE_PACKAGE_BINDING_DENIED', 'Packages must be bound before bootstrap start.');
      await packageBindings.install(host, packages);
    },
    start(host: NativeBootstrapHost, signal: AbortSignal = context.signal): Promise<void> {
      sameHost(host);
      if (starting && ['starting', 'running'].includes(state)) return starting;
      assert(state === 'installed' && !lifetime.aborted, 'NATIVE_BOOTSTRAP_START_DENIED', 'Bootstrap is not installed or has stopped.');
      state = 'starting';
      starting = withDeadline({ signal: AbortSignal.any([lifetime, signal]), timeoutMs, code: 'NATIVE_BOOTSTRAP_START_TIMEOUT_UNKNOWN', run(combined) {
        pendingStart = true;
        rawStart = Promise.resolve().then(() => created.start?.(host, AbortSignal.any([lifetime, signal, combined])));
        rawStart.then(() => { pendingStart = false; }, () => { pendingStart = false; });
        return rawStart;
      } }).then(() => { state = 'running'; }, error => { controller.abort(); throw failure(error, 'NATIVE_BOOTSTRAP_START_FAILED'); });
      return starting;
    },
    stop(host: NativeBootstrapHost, signal: AbortSignal = new AbortController().signal): Promise<void> {
      sameHost(host);
      controller.abort();
      if (stopping) return stopping;
      state = 'stopping';
      stopping = withDeadline({ signal, timeoutMs, code: 'NATIVE_BOOTSTRAP_STOP_TIMEOUT_UNKNOWN', run(combined) {
        pendingStop = true;
        const raw = Promise.resolve().then(async () => {
          await rawStart?.catch(() => {});
          await packageBindings.stop(host);
          await created.stop?.(host, combined);
        });
        raw.then(() => { pendingStop = false; }, () => { pendingStop = false; });
        return raw;
      } }).then(() => { state = 'stopped'; }, error => { throw failure(error, 'NATIVE_BOOTSTRAP_STOP_FAILED'); });
      return stopping;
    },
    metadata() {
      return snapshot({ ...bootstrap.metadata, state, pendingStart, pendingStop,
        lifecycleHooks: (created.lifecycleHooks ?? []).map(({ id, checkpoint, kind }) => ({ id, checkpoint, kind })),
        features: (created.features ?? []).map(({ id, version, capabilities, subscriptions }) => ({ id, version, capabilities, subscriptions })),
        effectCapabilities: Object.keys({ ...created.effectAdapters, ...packageBridge.effectAdapters }),
        eventTypes: Object.keys({ ...created.eventValidators, ...packageBridge.eventValidators }),
        packages: packageBindings.metadata(), installedFeatureIds: [...installed], grantsCreatedByInstaller: false,
        mediaResolver: created.onebot?.resolveAsset !== undefined, forwardConfigured: created.onebot?.forward !== undefined });
    }
  });
}

export type NativeBootstrapMount = Awaited<ReturnType<typeof createNativeBootstrapMount>>;
