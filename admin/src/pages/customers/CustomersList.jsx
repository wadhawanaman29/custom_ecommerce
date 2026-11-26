import { Link } from 'react-router-dom';
import { api, wc } from '../../api';
import { useCollection, useNotice, useQueryState } from '../../hooks';
import { date } from '../../format';
import {
  ListTable, Notice, PageHeader, Pagination, SearchBox, StatusLinks, confirmDelete,
} from '../../components/ui';

const ROLES = [['all', 'All'], ['administrator', 'Administrator'], ['shop_manager', 'Shop manager'], ['editor', 'Editor'], ['author', 'Author'], ['customer', 'Customer'], ['subscriber', 'Subscriber']];

// role="customer" → WooCommerce › Customers; role="all" → Users (with role tabs)
export default function CustomersList({ role }) {
  const isUsers = role === 'all';
  const [q, setQ] = useQueryState({ page: '1', search: '', role: isUsers ? 'all' : 'customer', orderby: 'registered_date', order: 'desc' });
  const [notice, showNotice, closeNotice] = useNotice();
  const { items, total, totalPages, loading, error, reload } = useCollection(wc('customers'), { page: q.page, per_page: 20, search: q.search, role: q.role, orderby: q.orderby, order: q.order });
  const base = isUsers ? '/users' : '/customers';
  const remove = async (ids) => {
    try { await api.post(wc('customers/batch'), { delete: ids }); showNotice('success', `${ids.length} user(s) deleted.`); reload(); } catch (e) { showNotice('error', e.message); }
  };
  return (
    <>
      <PageHeader title={isUsers ? 'Users' : 'Customers'} action="Add New" actionTo="/users/new" />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="tablenav">
        {isUsers ? <StatusLinks value={q.role} onChange={(r) => setQ({ role: r })} items={ROLES.map(([value, label]) => ({ value, label }))} /> : <span />}
        <SearchBox value={q.search} onSearch={(search) => setQ({ search })} placeholder={isUsers ? 'Search users' : 'Search customers'} />
      </div>
      <div className="tablenav"><span /><Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} /></div>
      <ListTable items={items} loading={loading} error={error}
        bulkActions={[{ value: 'delete', label: 'Delete' }]}
        onBulk={(a, ids) => confirmDelete(`${ids.length} user(s) and their personal data`) && remove(ids)}
        sort={{ orderby: q.orderby, order: q.order }} onSort={(k) => setQ({ orderby: k, order: q.orderby === k && q.order === 'asc' ? 'desc' : 'asc' })}
        columns={[
          { key: 'name', label: 'Name', sortable: true, render: (u) => (
            <span className="flex"><img src={u.avatar_url} alt="" width={32} height={32} style={{ borderRadius: '50%' }} />
              <span><Link className="row-title" to={`${base}/${u.id}`}>{[u.first_name, u.last_name].filter(Boolean).join(' ') || u.username}</Link>
                <div className="row-actions"><span><Link to={`${base}/${u.id}`}>Edit</Link></span><span><Link to={`/orders?customer=${u.id}`}>Orders</Link></span></div></span></span>
          ) },
          { key: 'username', label: 'Username' },
          { key: 'email', label: 'Email', render: (u) => <a href={`mailto:${u.email}`}>{u.email}</a> },
          ...(isUsers ? [{ key: 'role', label: 'Role', render: (u) => (ROLES.find((r) => r[0] === u.role) || [0, u.role])[1] }] : []),
          { key: 'location', label: 'Location', render: (u) => [u.billing.city, u.billing.state, u.billing.country].filter(Boolean).join(', ') || '—' },
          { key: 'paying', label: 'Paying', render: (u) => (u.is_paying_customer ? 'Yes' : '—') },
          { key: 'registered_date', label: 'Registered', sortable: true, render: (u) => date(u.date_created) },
        ]} />
    </>
  );
}
