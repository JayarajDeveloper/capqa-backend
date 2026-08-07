/**
 * CapBO Navigation Model — extracted from app.routes.ts.
 * Every module with its real routes, form patterns, tabs, and cross-module access.
 * AUTO-GENERATED from the Angular router config.
 */

export const NAVIGATION = {
  partners: {
    route: '/partners',
    listRoute: '/partners',
    detailRoute: '/partners/details',
    formPattern: 'inline', // Add opens form on same page
    permission: 'PARTNERS',
    tabs: ['Info', 'Hierarchy', 'Internal'],
    childTabs: { Hierarchy: '/partners/details#hierarchy' },
  },
  articles: {
    route: '/articles',
    listRoute: '/articles',
    detailRoute: '/articles/details',
    formPattern: 'dialog', // Edit opens dialog with tabs, Create opens modal
    permission: 'ARTICLES',
    tabs: ['General', 'Partners', 'Stock', 'Documents'],
    childRoutes: {
      'partner-details': { component: 'ArticlePartnerDetail', access: 'Partners tab → Add' },
      'local': { component: 'ArticleLocalList', permission: 'LOCAL_ARTICLES' },
    },
  },
  articlePartner: {
    // TWO access paths:
    // 1. Direct: /article-partner/details (sidebar menu → standalone list + form)
    // 2. Contextual: /articles/partner-details (article dialog → Partners tab → Add → opens form)
    route: '/article-partner',
    detailRoute: '/article-partner/details',
    contextualRoute: '/articles/partner-details',
    formPattern: 'inline', // Form opens as part of list or inside dialog
    permission: 'ARTICLE_PARTNERS',
    parentModule: 'articles',
    navigationNote: 'For linking: navigate /articles → click article → switch Partners tab → click Add. For standalone: use /article-partner.',
  },
  articleEcotax: {
    route: '/article-ecotax',
    listRoute: '/article-ecotax',
    detailRoute: '/article-ecotax/details',
    formPattern: 'inline',
    permission: 'ARTICLE_ECOTAXES',
  },
  vat: {
    route: '/vat',
    listRoute: '/vat',
    detailRoute: '/vat/details',
    formPattern: 'inline',
    permission: 'VAT',
  },
  currency: {
    route: '/currency',
    listRoute: '/currency',
    detailRoute: '/currency/details',
    formPattern: 'inline',
    permission: 'CURRENCIES',
  },
  ecoTax: {
    route: '/eco-tax',
    listRoute: '/eco-tax',
    detailRoute: '/eco-tax/details',
    formPattern: 'inline',
    permission: 'ECOTAXES',
  },
  retailChain: {
    route: '/retail-chains',
    listRoute: '/retail-chains',
    detailRoute: '/retail-chains/details',
    formPattern: 'inline',
    permission: 'RETAIL_CHAINS',
  },
  attributes: {
    route: '/attributes',
    listRoute: '/attributes',
    detailRoute: '/attributes/details',
    formPattern: 'inline',
    permission: 'ATTRIBUTES',
  },
  commercialAgreement: {
    route: '/commercial-agreement',
    listRoute: '/commercial-agreement',
    detailRoute: '/commercial-agreement/details',
    formPattern: 'inline',
    permission: 'PARTNER_AGREEMENTS',
  },
  commercialAgreementType: {
    route: '/commercial-agreement-type',
    listRoute: '/commercial-agreement-type',
    detailRoute: '/commercial-agreement-type/details',
    formPattern: 'inline',
    permission: 'COMMERCIAL_AGREEMENT_TYPE',
  },
  stockMovements: {
    route: '/stock-movements',
    listRoute: '/stock-movements',
    detailRoute: '/stock-movements/details',
    formPattern: 'inline',
    permission: 'STOCK_MOVEMENTS',
  },
  stockMovementTypes: {
    route: '/stock-movement-types',
    listRoute: '/stock-movement-types',
    detailRoute: '/stock-movement-types/details',
    formPattern: 'inline',
    permission: 'TYPES_OF_STOCK_MOVEMENTS',
  },
  trunks: {
    route: '/trunks',
    listRoute: '/trunks',
    detailRoute: '/trunks/details',
    formPattern: 'inline',
    permission: 'TRUNKS',
  },
  assortments: {
    route: '/assortments',
    listRoute: '/assortments',
    detailRoute: '/assortments/details',
    formPattern: 'inline',
    permission: 'ASSORTMENT_ASSIGNMENT',
  },
  purchaseOrders: {
    route: '/purchase-orders',
    listRoute: '/purchase-orders',
    detailRoute: '/purchase-orders/details',
    formPattern: 'inline',
    permission: 'PURCHASE_ORDERS',
  },
  users: {
    route: '/users',
    listRoute: '/users',
    detailRoute: '/users/details',
    formPattern: 'inline',
    permission: 'USERS',
  },
  sites: {
    route: '/sites',
    listRoute: '/sites',
    detailRoute: '/sites/details',
    formPattern: 'inline',
    permission: 'SITES',
  },
  groups: {
    route: '/groups',
    listRoute: '/groups',
    detailRoute: '/groups/details',
    formPattern: 'inline',
    permission: 'SITE_GROUPS',
  },
  groupOfUsers: {
    route: '/group-of-users',
    listRoute: '/group-of-users',
    detailRoute: '/group-of-users/details',
    formPattern: 'inline',
    permission: 'GROUP_OF_USERS',
  },
  articleHierarchy: {
    route: '/article-hierarchy',
    listRoute: '/article-hierarchy',
    detailRoute: '/article-hierarchy/details',
    formPattern: 'inline',
    permission: 'ARTICLE_HIERARCHIES',
  },
  articleLists: {
    route: '/article-lists',
    listRoute: '/article-lists',
    detailRoute: '/article-lists/details',
    formPattern: 'inline',
    permission: 'ARTICLE_LISTS',
  },
  metricUnits: {
    route: '/metric-units',
    listRoute: '/metric-units',
    detailRoute: '/metric-units/details',
    formPattern: 'inline',
    permission: 'UNITS',
  },
  documentManagement: {
    route: '/document-management',
    listRoute: '/document-management',
    detailRoute: '/document-management/details',
    formPattern: 'inline',
    permission: 'DOCUMENT_TYPES',
  },
};

/** Map feature/entity names to their navigation entry. */
const NAME_MAP = {
  partner: 'partners', partners: 'partners', Partner: 'partners',
  article: 'articles', articles: 'articles', Article: 'articles',
  articlepartner: 'articlePartner', 'article-partner': 'articlePartner', ArticlePartner: 'articlePartner',
  currency: 'currency', currencies: 'currency', Currency: 'currency',
  vat: 'vat', Vat: 'vat',
  ecotax: 'ecoTax', 'eco-tax': 'ecoTax', EcoTax: 'ecoTax',
  'retail-chain': 'retailChain', retailchain: 'retailChain', RetailChain: 'retailChain',
  attribute: 'attributes', attributes: 'attributes',
  'commercial-agreement': 'commercialAgreement', commercialagreement: 'commercialAgreement',
  'stock-movement': 'stockMovements', stockmovement: 'stockMovements', StockMovement: 'stockMovements',
  trunk: 'trunks', trunks: 'trunks',
  assortment: 'assortments', assortments: 'assortments',
  'purchase-order': 'purchaseOrders', purchaseorder: 'purchaseOrders',
  site: 'sites', sites: 'sites', Site: 'sites',
  user: 'users', users: 'users', User: 'users',
  group: 'groups', groups: 'groups',
  'article-hierarchy': 'articleHierarchy', articlehierarchy: 'articleHierarchy',
  'metric-unit': 'metricUnits', metricunit: 'metricUnits',
  document: 'documentManagement', 'document-type': 'documentManagement',
};

export function resolveNavigation(entityName) {
  const key = NAME_MAP[entityName] || NAME_MAP[entityName.toLowerCase()] || entityName;
  return NAVIGATION[key] || null;
}

export function getRoute(entityName) {
  const nav = resolveNavigation(entityName);
  return nav?.route || nav?.listRoute || null;
}

export function buildNavigationPrompt(entityName) {
  const nav = resolveNavigation(entityName);
  if (!nav) return `No navigation data for ${entityName}`;

  const lines = [`\nNAVIGATION: ${entityName}`];
  lines.push(`  List: ${nav.listRoute || 'none'}`);
  lines.push(`  Detail/Create: ${nav.detailRoute || 'none'}`);
  lines.push(`  Form opens: ${nav.formPattern}`);

  if (nav.tabs?.length) {
    lines.push(`  Tabs: ${nav.tabs.join(' → ')}`);
  }

  if (nav.navigationNote) {
    lines.push(`  ⚠ ${nav.navigationNote}`);
  }

  if (nav.permission) {
    lines.push(`  Permission: ${nav.permission}`);
  }

  if (nav.parentModule) {
    lines.push(`  Parent: ${nav.parentModule}`);
  }

  return lines.join('\n');
}

/**
 * Generate complete cross-module navigation instructions.
 */
export function buildCrossModuleNavigation(entities) {
  const lines = ['\nCROSS-MODULE NAVIGATION FLOW:'];
  for (let i = 0; i < entities.length; i++) {
    const nav = resolveNavigation(entities[i]);
    if (!nav) continue;
    lines.push(`\n  Phase ${i + 1}: ${entities[i]}`);
    lines.push(`    Route: ${nav.listRoute || nav.route}`);
    if (nav.detailRoute) lines.push(`    Create/Edit: ${nav.detailRoute}`);
    if (nav.navigationNote) lines.push(`    ⚠ ${nav.navigationNote}`);
  }
  return lines.join('\n');
}
