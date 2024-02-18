import {
  CompletionItem,
  CompletionList,
  CompletionParams,
  Connection,
  DocumentColorParams,
  ColorInformation,
  ColorPresentation,
  Hover,
  InitializeParams,
  TextDocumentPositionParams,
  ColorPresentationParams,
  CodeActionParams,
  CodeAction,
  CompletionRequest,
  DocumentColorRequest,
  BulkRegistration,
  CodeActionRequest,
  BulkUnregistration,
  HoverRequest,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  Disposable,
  TextDocumentIdentifier,
  DocumentLinkRequest,
  DocumentLinkParams,
  DocumentLink,
  InitializeResult,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node'
import { URI } from 'vscode-uri'
import glob from 'fast-glob'
import normalizePath from 'normalize-path'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import type * as chokidar from 'chokidar'
import findUp from 'find-up'
import minimatch from 'minimatch'
import resolveFrom from './util/resolveFrom'
import * as semver from '@tailwindcss/language-service/src/util/semver'
import * as parcel from './watcher/index.js'
import { normalizeFileNameToFsPath } from './util/uri'
import { equal } from '@tailwindcss/language-service/src/util/array'
import { getTextWithoutComments } from '@tailwindcss/language-service/src/util/doc'
import { CONFIG_GLOB, CSS_GLOB, PACKAGE_LOCK_GLOB } from './lib/constants'
import { clearRequireCache, isObject, changeAffectsFile } from './utils'
import { DocumentService } from './documents'
import {
  createProjectService,
  ProjectService,
  DocumentSelector,
  DocumentSelectorPriority,
  ProjectConfig,
} from './projects'
import { SettingsCache, createSettingsCache } from './config'

const TRIGGER_CHARACTERS = [
  // class attributes
  '"',
  "'",
  '`',
  // between class names
  ' ',
  // @apply and emmet-style
  '.',
  // config/theme helper
  '(',
  '[',
  // JIT "important" prefix
  '!',
  // JIT opacity modifiers
  '/',
] as const

async function getConfigFileFromCssFile(cssFile: string): Promise<string | null> {
  let css = getTextWithoutComments(await fs.promises.readFile(cssFile, 'utf8'), 'css')
  let match = css.match(/@config\s*(?<config>'[^']+'|"[^"]+")/)
  if (!match) {
    return null
  }
  return normalizePath(path.resolve(path.dirname(cssFile), match.groups.config.slice(1, -1)))
}

function getPackageRoot(cwd: string, rootDir: string) {
  try {
    let pkgJsonPath = findUp.sync(
      (dir) => {
        let pkgJson = path.join(dir, 'package.json')
        if (findUp.sync.exists(pkgJson)) {
          return pkgJson
        }
        if (dir === path.normalize(rootDir)) {
          return findUp.stop
        }
      },
      { cwd }
    )
    return pkgJsonPath ? path.dirname(pkgJsonPath) : rootDir
  } catch {
    return rootDir
  }
}

function getContentDocumentSelectorFromConfigFile(
  configPath: string,
  tailwindVersion: string,
  rootDir: string,
  actualConfig?: any
): DocumentSelector[] {
  let config = actualConfig ?? require(configPath)
  let contentConfig: unknown = config.content?.files ?? config.content
  let content = Array.isArray(contentConfig) ? contentConfig : []
  let relativeEnabled = semver.gte(tailwindVersion, '3.2.0')
    ? config.future?.relativeContentPathsByDefault || config.content?.relative
    : false
  let contentBase: string
  if (relativeEnabled) {
    contentBase = path.dirname(configPath)
  } else {
    contentBase = getPackageRoot(path.dirname(configPath), rootDir)
  }
  return content
    .filter((item): item is string => typeof item === 'string')
    .map((item) =>
      item.startsWith('!')
        ? `!${path.resolve(contentBase, item.slice(1))}`
        : path.resolve(contentBase, item)
    )
    .map((item) => ({
      pattern: normalizePath(item),
      priority: DocumentSelectorPriority.CONTENT_FILE,
    }))
}

export class TW {
  private initPromise: Promise<void>
  private lspHandlersAdded = false
  private projects: Map<string, ProjectService>
  private projectCounter: number
  private documentService: DocumentService
  public initializeParams: InitializeParams
  private registrations: Promise<BulkUnregistration>
  private disposables: Disposable[] = []
  private watchPatterns: (patterns: string[]) => void = () => {}
  private watched: string[] = []

  private settingsCache: SettingsCache

  constructor(private connection: Connection) {
    this.documentService = new DocumentService(this.connection)
    this.projects = new Map()
    this.projectCounter = 0
    this.settingsCache = createSettingsCache(connection)
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this._init()
    }
    await this.initPromise
  }

  private async _init(): Promise<void> {
    clearRequireCache()

    let base: string
    if (this.initializeParams.rootUri) {
      base = URI.parse(this.initializeParams.rootUri).fsPath
    } else if (this.initializeParams.rootPath) {
      base = normalizeFileNameToFsPath(this.initializeParams.rootPath)
    }

    if (!base) {
      console.error('No workspace folders found, not initializing.')
      return
    }

    base = normalizePath(base)

    let workspaceFolders: Array<ProjectConfig> = []
    let globalSettings = await this.settingsCache.getConfiguration()
    let ignore = globalSettings.tailwindCSS.files.exclude
    let configFileOrFiles = globalSettings.tailwindCSS.experimental.configFile

    let cssFileConfigMap: Map<string, string> = new Map()
    let configTailwindVersionMap: Map<string, string> = new Map()

    // base directory to resolve relative `experimental.configFile` paths against
    let userDefinedConfigBase = this.initializeParams.initializationOptions?.workspaceFile
      ? path.dirname(this.initializeParams.initializationOptions.workspaceFile)
      : base

    if (configFileOrFiles) {
      if (
        typeof configFileOrFiles !== 'string' &&
        (!isObject(configFileOrFiles) ||
          !Object.entries(configFileOrFiles).every(([key, value]) => {
            if (typeof key !== 'string') return false
            if (Array.isArray(value)) {
              return value.every((item) => typeof item === 'string')
            }
            return typeof value === 'string'
          }))
      ) {
        console.error('Invalid `experimental.configFile` configuration, not initializing.')
        return
      }

      let configFiles =
        typeof configFileOrFiles === 'string'
          ? { [configFileOrFiles]: path.resolve(base, '**') }
          : configFileOrFiles

      workspaceFolders = Object.entries(configFiles).map(
        ([relativeConfigPath, relativeDocumentSelectorOrSelectors]) => {
          return {
            folder: base,
            configPath: normalizePath(path.resolve(userDefinedConfigBase, relativeConfigPath)),
            documentSelector: [].concat(relativeDocumentSelectorOrSelectors).map((selector) => ({
              priority: DocumentSelectorPriority.USER_CONFIGURED,
              pattern: normalizePath(path.resolve(userDefinedConfigBase, selector)),
            })),
            isUserConfigured: true,
          }
        }
      )
    } else {
      let projects: Record<string, Array<DocumentSelector>> = {}

      let files = await glob([`**/${CONFIG_GLOB}`, `**/${CSS_GLOB}`], {
        cwd: base,
        ignore: (await this.settingsCache.getConfiguration()).tailwindCSS.files.exclude,
        onlyFiles: true,
        absolute: true,
        suppressErrors: true,
        dot: true,
        concurrency: Math.max(os.cpus().length, 1),
      })

      for (let filename of files) {
        let normalizedFilename = normalizePath(filename)
        let isCssFile = minimatch(normalizedFilename, `**/${CSS_GLOB}`, { dot: true })
        let configPath = isCssFile ? await getConfigFileFromCssFile(filename) : filename
        if (!configPath) {
          continue
        }

        let twVersion = require('tailwindcss/package.json').version
        let isDefaultVersion = true
        try {
          let v = require(resolveFrom(path.dirname(configPath), 'tailwindcss/package.json')).version
          if (typeof v === 'string') {
            twVersion = v
            isDefaultVersion = false
          }
        } catch {}

        if (isCssFile && (!semver.gte(twVersion, '3.2.0') || isDefaultVersion)) {
          continue
        }

        if (
          (configPath.endsWith('.ts') || configPath.endsWith('.mjs')) &&
          !semver.gte(twVersion, '3.3.0')
        ) {
          continue
        }

        configTailwindVersionMap.set(configPath, twVersion)

        let contentSelector: Array<DocumentSelector> = []
        try {
          contentSelector = getContentDocumentSelectorFromConfigFile(configPath, twVersion, base)
        } catch {}

        let documentSelector: DocumentSelector[] = [
          {
            pattern: normalizePath(filename),
            priority: isCssFile
              ? DocumentSelectorPriority.CSS_FILE
              : DocumentSelectorPriority.CONFIG_FILE,
          },
          ...(isCssFile
            ? [
                {
                  pattern: normalizePath(configPath),
                  priority: DocumentSelectorPriority.CONFIG_FILE,
                },
              ]
            : []),
          ...contentSelector,
          {
            pattern: normalizePath(path.join(path.dirname(filename), '**')),
            priority: isCssFile
              ? DocumentSelectorPriority.CSS_DIRECTORY
              : DocumentSelectorPriority.CONFIG_DIRECTORY,
          },
          ...(isCssFile
            ? [
                {
                  pattern: normalizePath(path.join(path.dirname(configPath), '**')),
                  priority: DocumentSelectorPriority.CONFIG_DIRECTORY,
                },
              ]
            : []),
          {
            pattern: normalizePath(path.join(getPackageRoot(path.dirname(configPath), base), '**')),
            priority: DocumentSelectorPriority.PACKAGE_DIRECTORY,
          },
        ]

        projects[configPath] = [...(projects[configPath] ?? []), ...documentSelector]

        if (isCssFile) {
          cssFileConfigMap.set(normalizedFilename, configPath)
        }
      }

      let projectKeys = Object.keys(projects)
      let projectCount = projectKeys.length

      if (projectCount > 0) {
        if (projectCount === 1) {
          projects[projectKeys[0]].push({
            pattern: normalizePath(path.join(base, '**')),
            priority: DocumentSelectorPriority.ROOT_DIRECTORY,
          })
        }
        workspaceFolders = Object.entries(projects).map(([configPath, documentSelector]) => {
          return {
            folder: base,
            configPath,
            isUserConfigured: false,
            documentSelector: documentSelector
              .sort((a, z) => a.priority - z.priority)
              .filter(
                ({ pattern }, index, documentSelectors) =>
                  documentSelectors.findIndex(({ pattern: p }) => p === pattern) === index
              ),
          }
        })
      }
    }

    console.log(`[Global] Creating projects: ${JSON.stringify(workspaceFolders)}`)

    const onDidChangeWatchedFiles = async (
      changes: Array<{ file: string; type: FileChangeType }>
    ): Promise<void> => {
      let needsRestart = false

      changeLoop: for (let change of changes) {
        let normalizedFilename = normalizePath(change.file)

        for (let ignorePattern of ignore) {
          if (minimatch(normalizedFilename, ignorePattern, { dot: true })) {
            continue changeLoop
          }
        }

        let isPackageFile = minimatch(normalizedFilename, `**/${PACKAGE_LOCK_GLOB}`, { dot: true })
        if (isPackageFile) {
          for (let [, project] of this.projects) {
            let twVersion = require('tailwindcss/package.json').version
            try {
              let v = require(resolveFrom(
                path.dirname(project.projectConfig.configPath),
                'tailwindcss/package.json'
              )).version
              if (typeof v === 'string') {
                twVersion = v
              }
            } catch {}
            if (configTailwindVersionMap.get(project.projectConfig.configPath) !== twVersion) {
              needsRestart = true
              break changeLoop
            }
          }
        }

        let isCssFile = minimatch(normalizedFilename, `**/${CSS_GLOB}`, {
          dot: true,
        })
        if (isCssFile && change.type !== FileChangeType.Deleted) {
          let configPath = await getConfigFileFromCssFile(change.file)
          if (
            cssFileConfigMap.has(normalizedFilename) &&
            cssFileConfigMap.get(normalizedFilename) !== configPath
          ) {
            needsRestart = true
            break
          } else if (!cssFileConfigMap.has(normalizedFilename) && configPath) {
            needsRestart = true
            break
          }
        }

        let isConfigFile = minimatch(normalizedFilename, `**/${CONFIG_GLOB}`, {
          dot: true,
        })
        if (isConfigFile && change.type === FileChangeType.Created) {
          needsRestart = true
          break
        }

        for (let [, project] of this.projects) {
          if (
            change.type === FileChangeType.Deleted &&
            changeAffectsFile(normalizedFilename, [project.projectConfig.configPath])
          ) {
            needsRestart = true
            break changeLoop
          }
        }
      }

      if (needsRestart) {
        this.restart()
        return
      }

      for (let [, project] of this.projects) {
        project.onFileEvents(changes)
      }
    }

    if (this.initializeParams.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration) {
      this.disposables.push(
        this.connection.onDidChangeWatchedFiles(async ({ changes }) => {
          let normalizedChanges = changes
            .map(({ uri, type }) => ({
              file: URI.parse(uri).fsPath,
              type,
            }))
            .filter(
              (change, changeIndex, changes) =>
                changes.findIndex((c) => c.file === change.file && c.type === change.type) ===
                changeIndex
            )

          await onDidChangeWatchedFiles(normalizedChanges)
        })
      )

      let disposable = await this.connection.client.register(
        DidChangeWatchedFilesNotification.type,
        {
          watchers: [
            { globPattern: `**/${CONFIG_GLOB}` },
            { globPattern: `**/${PACKAGE_LOCK_GLOB}` },
            { globPattern: `**/${CSS_GLOB}` },
          ],
        }
      )

      this.disposables.push(disposable)

      this.watchPatterns = (patterns) => {
        let newPatterns = this.filterNewWatchPatterns(patterns)
        if (newPatterns.length) {
          console.log(`[Global] Adding watch patterns: ${newPatterns.join(', ')}`)
          this.connection.client
            .register(DidChangeWatchedFilesNotification.type, {
              watchers: newPatterns.map((pattern) => ({ globPattern: pattern })),
            })
            .then((disposable) => {
              this.disposables.push(disposable)
            })
        }
      }
    } else if (parcel.getBinding()) {
      let typeMap = {
        create: FileChangeType.Created,
        update: FileChangeType.Changed,
        delete: FileChangeType.Deleted,
      }

      let subscription = await parcel.subscribe(
        base,
        (err, events) => {
          onDidChangeWatchedFiles(
            events.map((event) => ({ file: event.path, type: typeMap[event.type] }))
          )
        },
        {
          ignore: ignore.map((ignorePattern) =>
            path.resolve(base, ignorePattern.replace(/^[*/]+/, '').replace(/[*/]+$/, ''))
          ),
        }
      )

      this.disposables.push({
        dispose() {
          subscription.unsubscribe()
        },
      })
    } else {
      let watch: typeof chokidar.watch = require('chokidar').watch
      let chokidarWatcher = watch(
        [`**/${CONFIG_GLOB}`, `**/${PACKAGE_LOCK_GLOB}`, `**/${CSS_GLOB}`],
        {
          cwd: base,
          ignorePermissionErrors: true,
          ignoreInitial: true,
          ignored: ignore,
          awaitWriteFinish: {
            stabilityThreshold: 100,
            pollInterval: 20,
          },
        }
      )

      await new Promise<void>((resolve) => {
        chokidarWatcher.on('ready', () => resolve())
      })

      chokidarWatcher
        .on('add', (file) =>
          onDidChangeWatchedFiles([
            { file: path.resolve(base, file), type: FileChangeType.Created },
          ])
        )
        .on('change', (file) =>
          onDidChangeWatchedFiles([
            { file: path.resolve(base, file), type: FileChangeType.Changed },
          ])
        )
        .on('unlink', (file) =>
          onDidChangeWatchedFiles([
            { file: path.resolve(base, file), type: FileChangeType.Deleted },
          ])
        )

      this.disposables.push({
        dispose() {
          chokidarWatcher.close()
        },
      })

      this.watchPatterns = (patterns) => {
        let newPatterns = this.filterNewWatchPatterns(patterns)
        if (newPatterns.length) {
          console.log(`[Global] Adding watch patterns: ${newPatterns.join(', ')}`)
          chokidarWatcher.add(newPatterns)
        }
      }
    }

    await Promise.all(
      workspaceFolders.map((projectConfig) =>
        this.addProject(
          projectConfig,
          this.initializeParams,
          this.watchPatterns,
          configTailwindVersionMap.get(projectConfig.configPath)
        )
      )
    )

    // init projects for documents that are _already_ open
    for (let document of this.documentService.getAllDocuments()) {
      let project = this.getProject(document)
      if (project && !project.enabled()) {
        project.enable()
        await project.tryInit()
      }
    }

    this.setupLSPHandlers()

    this.disposables.push(
      this.connection.onDidChangeConfiguration(async ({ settings }) => {
        let previousExclude = globalSettings.tailwindCSS.files.exclude

        this.settingsCache.clear()

        globalSettings = await this.settingsCache.getConfiguration()

        if (!equal(previousExclude, globalSettings.tailwindCSS.files.exclude)) {
          this.restart()
          return
        }

        for (let [, project] of this.projects) {
          project.onUpdateSettings(settings)
        }
      })
    )

    this.disposables.push(
      this.connection.onShutdown(() => {
        this.dispose()
      })
    )

    this.disposables.push(
      this.documentService.onDidChangeContent((change) => {
        this.getProject(change.document)?.provideDiagnostics(change.document)
      })
    )

    this.disposables.push(
      this.documentService.onDidOpen((event) => {
        let project = this.getProject(event.document)
        if (project && !project.enabled()) {
          project.enable()
          project.tryInit()
        }
      })
    )
  }

  private filterNewWatchPatterns(patterns: string[]) {
    let newWatchPatterns = patterns.filter((pattern) => !this.watched.includes(pattern))
    this.watched.push(...newWatchPatterns)
    return newWatchPatterns
  }

  private async addProject(
    projectConfig: ProjectConfig,
    params: InitializeParams,
    watchPatterns: (patterns: string[]) => void,
    tailwindVersion: string
  ): Promise<void> {
    let key = String(this.projectCounter++)
    const project = await createProjectService(
      key,
      projectConfig,
      this.connection,
      params,
      this.documentService,
      () => this.updateCapabilities(),
      () => {
        for (let document of this.documentService.getAllDocuments()) {
          let project = this.getProject(document)
          if (project && !project.enabled()) {
            project.enable()
            project.tryInit()
            break
          }
        }
      },
      () => this.refreshDiagnostics(),
      (patterns: string[]) => watchPatterns(patterns),
      tailwindVersion,
      this.settingsCache.getConfiguration
    )
    this.projects.set(key, project)
  }

  private refreshDiagnostics() {
    for (let doc of this.documentService.getAllDocuments()) {
      let project = this.getProject(doc)
      if (project) {
        project.provideDiagnosticsForce(doc)
      } else {
        this.connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] })
      }
    }
  }

  setupLSPHandlers() {
    if (this.lspHandlersAdded) {
      return
    }
    this.lspHandlersAdded = true

    this.connection.onHover(this.onHover.bind(this))
    this.connection.onCompletion(this.onCompletion.bind(this))
    this.connection.onCompletionResolve(this.onCompletionResolve.bind(this))
    this.connection.onDocumentColor(this.onDocumentColor.bind(this))
    this.connection.onColorPresentation(this.onColorPresentation.bind(this))
    this.connection.onCodeAction(this.onCodeAction.bind(this))
    this.connection.onDocumentLinks(this.onDocumentLinks.bind(this))
    this.connection.onRequest(this.onRequest.bind(this))
  }

  private onRequest(
    method: '@/tailwindCSS/sortSelection',
    params: { uri: string; classLists: string[] }
  ): { error: string } | { classLists: string[] }
  private onRequest(
    method: '@/tailwindCSS/getProject',
    params: { uri: string }
  ): { version: string } | null
  private onRequest(method: string, params: any): any {
    if (method === '@/tailwindCSS/sortSelection') {
      let project = this.getProject({ uri: params.uri })
      if (!project) {
        return { error: 'no-project' }
      }
      try {
        return { classLists: project.sortClassLists(params.classLists) }
      } catch {
        return { error: 'unknown' }
      }
    }

    if (method === '@/tailwindCSS/getProject') {
      let project = this.getProject({ uri: params.uri })
      if (!project || !project.enabled() || !project.state?.enabled) {
        return null
      }
      return {
        version: project.state.version,
      }
    }
  }

  private updateCapabilities() {
    if (!supportsDynamicRegistration(this.initializeParams)) {
      return
    }

    if (this.registrations) {
      this.registrations.then((r) => r.dispose())
    }

    let projects = Array.from(this.projects.values())

    let capabilities = BulkRegistration.create()

    capabilities.add(HoverRequest.type, { documentSelector: null })
    capabilities.add(DocumentColorRequest.type, { documentSelector: null })
    capabilities.add(CodeActionRequest.type, { documentSelector: null })
    capabilities.add(DocumentLinkRequest.type, { documentSelector: null })

    capabilities.add(CompletionRequest.type, {
      documentSelector: null,
      resolveProvider: true,
      triggerCharacters: [
        ...TRIGGER_CHARACTERS,
        ...projects
          .map((project) => project.state.separator)
          .filter((sep) => typeof sep === 'string')
          .map((sep) => sep.slice(-1)),
      ].filter(Boolean),
    })

    this.registrations = this.connection.client.register(capabilities)
  }

  private getProject(document: TextDocumentIdentifier): ProjectService {
    let fallbackProject: ProjectService
    let matchedProject: ProjectService
    let matchedPriority: number = Infinity

    for (let [, project] of this.projects) {
      if (project.projectConfig.configPath) {
        let documentSelector = project
          .documentSelector()
          .concat()
          // move all the negated patterns to the front
          .sort((a, z) => {
            if (a.pattern.startsWith('!') && !z.pattern.startsWith('!')) {
              return -1
            }
            if (!a.pattern.startsWith('!') && z.pattern.startsWith('!')) {
              return 1
            }
            return 0
          })
        for (let selector of documentSelector) {
          let fsPath = URI.parse(document.uri).fsPath
          let pattern = selector.pattern.replace(/[\[\]{}]/g, (m) => `\\${m}`)
          if (pattern.startsWith('!') && minimatch(fsPath, pattern.slice(1), { dot: true })) {
            break
          }
          if (minimatch(fsPath, pattern, { dot: true }) && selector.priority < matchedPriority) {
            matchedProject = project
            matchedPriority = selector.priority
          }
        }
      } else {
        if (!fallbackProject) {
          fallbackProject = project
        }
      }
    }

    if (matchedProject) {
      return matchedProject
    }

    return fallbackProject
  }

  async onDocumentColor(params: DocumentColorParams): Promise<ColorInformation[]> {
    await this.init()
    return this.getProject(params.textDocument)?.onDocumentColor(params) ?? []
  }

  async onColorPresentation(params: ColorPresentationParams): Promise<ColorPresentation[]> {
    await this.init()
    return this.getProject(params.textDocument)?.onColorPresentation(params) ?? []
  }

  async onHover(params: TextDocumentPositionParams): Promise<Hover> {
    await this.init()
    return this.getProject(params.textDocument)?.onHover(params) ?? null
  }

  async onCompletion(params: CompletionParams): Promise<CompletionList> {
    await this.init()
    return this.getProject(params.textDocument)?.onCompletion(params) ?? null
  }

  async onCompletionResolve(item: CompletionItem): Promise<CompletionItem> {
    await this.init()
    return this.projects.get(item.data?._projectKey)?.onCompletionResolve(item) ?? null
  }

  async onCodeAction(params: CodeActionParams): Promise<CodeAction[]> {
    await this.init()
    return this.getProject(params.textDocument)?.onCodeAction(params) ?? null
  }

  async onDocumentLinks(params: DocumentLinkParams): Promise<DocumentLink[]> {
    await this.init()
    return this.getProject(params.textDocument)?.onDocumentLinks(params) ?? null
  }

  setup() {
    this.connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
      this.initializeParams = params

      if (supportsDynamicRegistration(params)) {
        return {
          capabilities: {
            textDocumentSync: TextDocumentSyncKind.Full,
          },
        }
      }

      this.setupLSPHandlers()

      return {
        capabilities: {
          textDocumentSync: TextDocumentSyncKind.Full,
          hoverProvider: true,
          colorProvider: true,
          codeActionProvider: true,
          documentLinkProvider: {},
          completionProvider: {
            resolveProvider: true,
            triggerCharacters: [...TRIGGER_CHARACTERS, ':'],
          },
        },
      }
    })

    this.connection.onInitialized(() => this.init())
  }

  listen() {
    this.connection.listen()
  }

  dispose(): void {
    this.connection.sendNotification('@/tailwindCSS/projectsDestroyed')
    for (let [, project] of this.projects) {
      project.dispose()
    }
    this.projects = new Map()

    this.refreshDiagnostics()

    if (this.registrations) {
      this.registrations.then((r) => r.dispose())
      this.registrations = undefined
    }

    this.disposables.forEach((d) => d.dispose())
    this.disposables.length = 0

    this.watched.length = 0
  }

  restart(): void {
    console.log('----------\nRESTARTING\n----------')
    this.dispose()
    this.initPromise = undefined
    this.init()
  }
}

function supportsDynamicRegistration(params: InitializeParams): boolean {
  return (
    params.capabilities.textDocument.hover?.dynamicRegistration &&
    params.capabilities.textDocument.colorProvider?.dynamicRegistration &&
    params.capabilities.textDocument.codeAction?.dynamicRegistration &&
    params.capabilities.textDocument.completion?.dynamicRegistration &&
    params.capabilities.textDocument.documentLink?.dynamicRegistration
  )
}
