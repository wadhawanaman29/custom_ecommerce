import { useEffect } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { api, custom } from './api';
import { useAuth } from './auth';
import { setCurrency } from './format';
import Layout from './components/Layout';
import { Loading } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import ProductsList from './pages/products/ProductsList';
import ProductEdit from './pages/products/ProductEdit';
import Attributes from './pages/products/Attributes';
import AttributeTerms from './pages/products/AttributeTerms';
import Reviews from './pages/products/Reviews';
import TermsPage from './pages/TermsPage';
import OrdersList from './pages/orders/OrdersList';
import OrderEdit from './pages/orders/OrderEdit';
import CustomersList from './pages/customers/CustomersList';
import UserEdit from './pages/customers/UserEdit';
import CouponsList from './pages/coupons/CouponsList';
import CouponEdit from './pages/coupons/CouponEdit';
import PostsList from './pages/content/PostsList';
import PostEdit from './pages/content/PostEdit';
import MediaLibrary from './pages/content/MediaLibrary';
import Comments from './pages/content/Comments';
import Menus from './pages/content/Menus';
import WooSettings from './pages/settings/WooSettings';
import SiteSettings from './pages/settings/SiteSettings';
import Reports from './pages/settings/Reports';
import Import from './pages/tools/Import';
import {
  CategoriesReport, CouponsReport, OrdersReport, Overview, ProductsReport, RevenueReport, TaxesReport,
} from './pages/analytics/Reports';
import Stock from './pages/analytics/Stock';
import AnalyticsSettings from './pages/analytics/AnalyticsSettings';
import ContentList from './pages/content/ContentList';
import ContentEdit from './pages/content/ContentEdit';
import ContentTypes from './pages/tools/ContentTypes';
import {
  AutoSku, EmailLog, OrderExport, OrderNumbers, PluginsOverview, Smtp, StorewideSale,
} from './pages/plugins/PluginPages';
import { ContentTypesProvider, useContentTypes } from './contentTypes';
import { wp } from './api';

// Custom taxonomy screen (e.g. Frontend Menu Categories)
function CustomTaxonomyPage() {
  const { tax } = useParams();
  const { registry } = useContentTypes();
  if (!registry) return <Loading />;
  const t = registry.taxonomies.find((x) => x.name === tax);
  if (!t) return <div className="notice notice-error"><span>Unknown taxonomy.</span></div>;
  return <TermsPage key={t.name} cfg={{ taxonomy: t.name, title: t.label, singular: (t.singular_label || t.label).toLowerCase(), path: wp(t.rest_base || t.name), hierarchical: !!t.hierarchical, wp: true }} />;
}
import ApiKeys from './pages/tools/ApiKeys';

export default function App() {
  const { user, ready } = useAuth();
  useEffect(() => {
    if (user) api.get(custom('store')).then((s) => setCurrency({ symbol: s.currency_symbol, code: s.currency })).catch(() => {});
  }, [user]);

  if (!ready) return <Loading />;
  if (!user) return <Login />;

  return (
    <ContentTypesProvider>
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />

        <Route path="products" element={<ProductsList />} />
        <Route path="products/new" element={<ProductEdit />} />
        <Route path="products/:id" element={<ProductEdit />} />
        <Route path="products/categories" element={<TermsPage kind="product_cat" />} />
        <Route path="products/tags" element={<TermsPage kind="product_tag" />} />
        <Route path="products/brands" element={<TermsPage kind="product_brand" />} />
        <Route path="products/shipping-classes" element={<TermsPage kind="shipping_class" />} />
        <Route path="products/attributes" element={<Attributes />} />
        <Route path="products/attributes/:id" element={<AttributeTerms />} />
        <Route path="products/reviews" element={<Reviews />} />

        <Route path="orders" element={<OrdersList />} />
        <Route path="orders/new" element={<OrderEdit />} />
        <Route path="orders/:id" element={<OrderEdit />} />
        <Route path="customers" element={<CustomersList role="customer" />} />
        <Route path="customers/:id" element={<UserEdit kind="customer" />} />
        <Route path="coupons" element={<CouponsList />} />
        <Route path="coupons/new" element={<CouponEdit />} />
        <Route path="coupons/:id" element={<CouponEdit />} />
        <Route path="reports" element={<Reports />} />
        <Route path="analytics" element={<Navigate to="/analytics/overview" replace />} />
        <Route path="analytics/overview" element={<Overview />} />
        <Route path="analytics/revenue" element={<RevenueReport />} />
        <Route path="analytics/orders" element={<OrdersReport />} />
        <Route path="analytics/products" element={<ProductsReport />} />
        <Route path="analytics/variations" element={<ProductsReport variations key="variations" />} />
        <Route path="analytics/categories" element={<CategoriesReport />} />
        <Route path="analytics/coupons" element={<CouponsReport />} />
        <Route path="analytics/taxes" element={<TaxesReport />} />
        <Route path="analytics/stock" element={<Stock />} />
        <Route path="analytics/settings" element={<AnalyticsSettings />} />
        <Route path="woo/settings" element={<WooSettings />} />
        <Route path="woo/settings/:tab" element={<WooSettings />} />

        <Route path="posts" element={<PostsList type="post" />} />
        <Route path="posts/new" element={<PostEdit type="post" />} />
        <Route path="posts/categories" element={<TermsPage kind="category" />} />
        <Route path="posts/tags" element={<TermsPage kind="post_tag" />} />
        <Route path="posts/:id" element={<PostEdit type="post" />} />
        <Route path="pages" element={<PostsList type="page" />} />
        <Route path="pages/new" element={<PostEdit type="page" />} />
        <Route path="pages/:id" element={<PostEdit type="page" />} />
        <Route path="media" element={<MediaLibrary />} />
        <Route path="comments" element={<Comments />} />
        <Route path="menus" element={<Menus />} />

        <Route path="users" element={<CustomersList role="all" />} />
        <Route path="users/new" element={<UserEdit kind="user" />} />
        <Route path="users/:id" element={<UserEdit kind="user" />} />

        <Route path="tools/import" element={<Import />} />
        <Route path="tools/api-keys" element={<ApiKeys />} />
        <Route path="tools/content-types" element={<ContentTypes />} />
        <Route path="plugins" element={<PluginsOverview />} />
        <Route path="plugins/order-numbers" element={<OrderNumbers />} />
        <Route path="plugins/storewide-sale" element={<StorewideSale />} />
        <Route path="plugins/auto-sku" element={<AutoSku />} />
        <Route path="plugins/smtp" element={<Smtp />} />
        <Route path="plugins/email-log" element={<EmailLog />} />
        <Route path="plugins/order-export" element={<OrderExport />} />
        <Route path="content/:type" element={<ContentList />} />
        <Route path="content/:type/new" element={<ContentEdit />} />
        <Route path="content/:type/tax/:tax" element={<CustomTaxonomyPage />} />
        <Route path="content/:type/:id" element={<ContentEdit key="edit" />} />
        <Route path="settings" element={<SiteSettings section="general" />} />
        <Route path="settings/reading" element={<SiteSettings section="reading" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </ContentTypesProvider>
  );
}
