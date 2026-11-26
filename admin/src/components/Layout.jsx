import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';

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
  { label: 'Tools', icon: '⚒', base: '/tools', perm: 'settings', children: [{ to: '/tools/import', label: 'Import from WordPress' }, { to: '/tools/api-keys', label: 'REST API keys' }] },
  { label: 'Settings', icon: '⚙', base: '/settings', perm: 'settings', children: [{ to: '/settings', label: 'General', end: true }, { to: '/settings/reading', label: 'Reading' }] },
];

const isOpen = (item, path) => item.base && (path.startsWith(item.base) || item.children.some((c) => path === c.to || path.startsWith(`${c.to}/`)));

export default function Layout() {
  const { user, logout, can } = useAuth();
  const { pathname } = useLocation();
  return (
    <div className="wp-shell">
      <nav className="wp-sidebar" aria-label="Main menu">
        <div className="brand">Store Admin</div>
        <ul className="wp-menu">
          {MENU.filter((m) => !m.perm || can(m.perm)).map((m) => {
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
