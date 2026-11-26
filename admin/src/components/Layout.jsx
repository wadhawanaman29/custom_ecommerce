import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { useContentTypes } from '../contentTypes';

const MENU = [
  { to: '/', label: 'Dashboard', icon: '⌂', end: true },
  { label: 'Posts', icon: '✎', base: '/posts', perm: 'content', children: [
    { to: '/posts', label: 'All Posts', end: true }, { to: '/posts/new', label: 'Add New' },
    { to: '/posts/categories', label: 'Categories' }, { to: '/posts/tags', label: 'Tags' },
  ] },
  { to: '/media', label: 'Media', icon: '▣', perm: 'content' },
  { label: 'Pages', icon: '▤', base: '/pages', perm: 'content', children: [{ to: '/pages', label: 'All Pages', end: true }, { to: '/pages/new', label: 'Add New' }] },
  { to: '/comments', label: 'Comments', icon: '✉', perm: 'content' },
  { label: 'WooCommerce', icon: '🛒', base: '/woo', perm: 'shop', children: [
    { to: '/orders', label: 'Orders' }, { to: '/customers', label: 'Customers' }, { to: '/coupons', label: 'Coupons' },
    { to: '/reports', label: 'Reports (legacy)' }, { to: '/woo/settings', label: 'Settings' },
  ] },
  { label: 'Products', icon: '▦', base: '/products', perm: 'shop', children: [
    { to: '/products', label: 'All Products', end: true }, { to: '/products/new', label: 'Add New' },
    { to: '/products/categories', label: 'Categories' }, { to: '/products/tags', label: 'Tags' },
    { to: '/products/attributes', label: 'Attributes' }, { to: '/products/shipping-classes', label: 'Shipping classes' },
    { to: '/products/reviews', label: 'Reviews' },
  ] },
  { label: 'Analytics', icon: '📊', base: '/analytics', perm: 'shop', children: [
    { to: '/analytics/overview', label: 'Overview' }, { to: '/analytics/products', label: 'Products' }, { to: '/analytics/revenue', label: 'Revenue' },
    { to: '/analytics/orders', label: 'Orders' }, { to: '/analytics/variations', label: 'Variations' }, { to: '/analytics/categories', label: 'Categories' },
    { to: '/analytics/coupons', label: 'Coupons' }, { to: '/analytics/taxes', label: 'Taxes' }, { to: '/analytics/stock', label: 'Stock' },
    { to: '/analytics/settings', label: 'Settings' },
  ] },
  { to: '/menus', label: 'Menus', icon: '☰', perm: 'settings' },
  { label: 'Users', icon: '👤', base: '/users', perm: 'users', children: [{ to: '/users', label: 'All Users', end: true }, { to: '/users/new', label: 'Add New' }] },
  { label: 'Tools', icon: '⚒', base: '/tools', perm: 'settings', children: [{ to: '/tools/import', label: 'Import from WordPress' }, { to: '/tools/content-types', label: 'Content Types' }, { to: '/tools/api-keys', label: 'REST API keys' }] },
  { label: 'Settings', icon: '⚙', base: '/settings', perm: 'settings', children: [{ to: '/settings', label: 'General', end: true }, { to: '/settings/reading', label: 'Reading' }] },
];

const isOpen = (item, path) => item.base && (path.startsWith(item.base) || item.children.some((c) => path === c.to || path.startsWith(`${c.to}/`)));

export default function Layout() {
  const { user, logout, can } = useAuth();
  const { pathname } = useLocation();
  const { registry } = useContentTypes();
  // Custom post types appear after Comments, like CPT UI menus in WordPress
  const custom = (registry ? registry.types : []).map((t) => ({
    label: t.label, icon: t.menu_icon && t.menu_icon.length <= 2 ? t.menu_icon : '📌', base: `/content/${t.name}`, perm: 'content',
    children: [
      { to: `/content/${t.name}`, label: `All ${t.label}`, end: true }, { to: `/content/${t.name}/new`, label: `Add new ${t.singular_label || t.label}` },
      ...registry.taxonomies.filter((x) => (t.taxonomies || []).includes(x.name) || (x.object_types || []).includes(t.name)).map((x) => ({ to: `/content/${t.name}/tax/${x.name}`, label: x.label })),
    ],
  }));
  const commentsAt = MENU.findIndex((m) => m.to === '/comments') + 1;
  const menu = [...MENU.slice(0, commentsAt), ...custom, ...MENU.slice(commentsAt)];
  return (
    <div className="wp-shell">
      <nav className="wp-sidebar" aria-label="Main menu">
        <div className="brand">Store Admin</div>
        <ul className="wp-menu">
          {menu.filter((m) => !m.perm || can(m.perm)).map((m) => {
            if (!m.children) {
              return (
                <li key={m.to} className={(m.end ? pathname === m.to : pathname.startsWith(m.to)) ? 'active' : ''}>
                  <NavLink to={m.to} end={m.end}><span className="icon">{m.icon}</span><span className="label">{m.label}</span></NavLink>
                </li>
              );
            }
            const open = isOpen(m, pathname);
            return (
              <li key={m.label} className={open ? 'active' : ''}>
                <NavLink to={m.children[0].to}><span className="icon">{m.icon}</span><span className="label">{m.label}</span></NavLink>
                {open && (
                  <ul className="wp-submenu">
                    {m.children.map((c) => <li key={c.to}><NavLink to={c.to} end={c.end} className={({ isActive }) => (isActive ? 'current' : '')}>{c.label}</NavLink></li>)}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="wp-main">
        <div className="wp-topbar">
          <span>Howdy, {user?.name}</span>
          <span className="flex">
            <a href="/wp-json/" target="_blank" rel="noreferrer">API</a>
            <button type="button" onClick={logout}>Log Out</button>
          </span>
        </div>
        <main className="wp-content"><Outlet /></main>
      </div>
    </div>
  );
}
