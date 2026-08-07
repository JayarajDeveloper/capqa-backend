/**
 * Target adapter: Symfony / API-Platform backend + Angular / Material frontend.
 *
 * Everything here is a STACK convention, not knowledge of any particular
 * application. `Shared`, `Common`, `Dto`, `Translation` are Symfony/DDD and
 * Doctrine naming conventions that happen to appear as directory names — they
 * describe the framework, not the business domain.
 *
 * To support a different stack, add a sibling pack and select it with
 * CAPQA_TARGET_ADAPTER. Nothing outside src/adapters/ should name a convention.
 */
export const adapter = {
  id: 'symfony-angular',

  /** Where source lives on disk. */
  layout: {
    apiFeaturesDir: ['src', 'Features'],
    apiEntityDir: 'Entity',
    apiServiceDir: 'Service',
    uiPagesDirs: [['src', 'app', 'pages'], ['app', 'pages']],
    uiI18nDirs: [['src', 'assets', 'i18n'], ['assets', 'i18n'], ['src', 'i18n']],
  },

  /** Directory segments whose children are feature folders. */
  featureContainerDirs: ['pages', 'Features', 'components', 'modules', 'views'],

  /** Folder names that are infrastructure rather than features. */
  nonFeatureFolders: ['shared', 'common', 'core', 'layout', 'ui', 'utils', 'helpers', 'services'],

  /** Feature-looking names that are never user-facing screens. */
  nonFeatureNames: ['Shared', 'Common', 'Core', 'Layout', 'Auth', 'Login'],

  /** Path segments holding cross-cutting types rather than screens. */
  nonScreenSegments: [
    'Shared', 'Common', 'Core', 'Enum', 'Enums', 'Dto', 'DTOs',
    'OpenApi', 'Serializer', 'Normalizer', 'Denormalizer', 'Chunker', 'Migration',
  ],

  /** Component filename suffixes stripped when deriving a feature name. */
  componentRoleSuffixes: ['list', 'form', 'detail', 'edit', 'create', 'index', 'show', 'table', 'view'],

  /** Translation-key namespaces that hold generic action labels (common.add, btn.create). */
  i18nActionNamespaces: ['common', 'actions', 'action', 'btn', 'buttons'],

  /** Doctrine i18n side-table naming convention. */
  i18nEntitySuffix: 'Translation',

  /**
   * Modules a generated spec imports at runtime. Paths are relative to the
   * generated-e2e/ directory and overridable per target via
   * CAPQA_SPEC_UI_HELPER / CAPQA_SPEC_API_HELPER / CAPQA_SPEC_AUTH_STATE.
   */
  specRuntime: {
    uiHelper: process.env.CAPQA_SPEC_UI_HELPER || './helpers/ui',
    apiHelper: process.env.CAPQA_SPEC_API_HELPER || './helpers/api',
    authState: process.env.CAPQA_SPEC_AUTH_STATE || './auth-state.mjs',
    /** Symbol names emitted into generated specs (must match helpers/* exports). */
    symbols: {
      ensureSession: 'ensureTargetSession',
      apiRequest: 'targetApiRequest',
      ensureToken: 'ensureAccessToken',
      resolveFirst: 'resolveApiFirstOptions',
    },
  },

  /**
   * Paths that rarely hold product business logic. These are infrastructure and
   * framework conventions only. Target-specific modules to deprioritise belong in
   * CAPQA_NOISE_PATHS (comma-separated), not here.
   */
  noisePathSegments: [
    'devops', 'keycloak', 'keycloack', 'migrations_bk', 'vendor', 'node_modules',
    'docs/', 'assets/i18n', '.github', 'docker', 'helm', 'terraform', 'Shared/Enum',
  ],

  /** Path-ranking rules: [regex source, flags, score delta]. */
  pathScores: [
    ['\\/pages\\/', 'i', 6],
    ['\\/Features\\/[^/]+\\/(Controller|Entity)\\/', 'i', 3],
    ['\\/(Shared|Enum)\\/', 'i', -20],
  ],
};
