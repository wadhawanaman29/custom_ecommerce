// Mirrors WooCommerce → Settings tabs and WordPress → Settings.
// Option ids are the same as wp_options names, so migrated values map 1:1.

const yesno = { yes: 'Yes', no: 'No' };

const groups = [
  { id: 'general', label: 'General', description: '', parent_id: '', sub_groups: [] },
  { id: 'products', label: 'Products', description: '', parent_id: '', sub_groups: [] },
  { id: 'tax', label: 'Tax', description: '', parent_id: '', sub_groups: [] },
  { id: 'shipping', label: 'Shipping', description: '', parent_id: '', sub_groups: [] },
  { id: 'checkout', label: 'Payments', description: '', parent_id: '', sub_groups: [] },
  { id: 'account', label: 'Accounts & Privacy', description: '', parent_id: '', sub_groups: [] },
  { id: 'email', label: 'Emails', description: '', parent_id: '', sub_groups: [] },
  { id: 'advanced', label: 'Advanced', description: '', parent_id: '', sub_groups: [] },
  { id: 'analytics', label: 'Analytics', description: '', parent_id: '', sub_groups: [] },
  { id: 'wp', label: 'WordPress', description: 'Site settings (Settings → General/Reading/Permalinks)', parent_id: '', sub_groups: [] },
];

const s = (group, id, label, type, def, extra = {}) => ({ group_id: group, id, label, type, default: def, description: '', tip: '', ...extra });

const settings = [
  // General
  s('general', 'woocommerce_store_address', 'Address line 1', 'text', ''),
  s('general', 'woocommerce_store_address_2', 'Address line 2', 'text', ''),
  s('general', 'woocommerce_store_city', 'City', 'text', ''),
  s('general', 'woocommerce_default_country', 'Country / State', 'select', 'US:CA'),
  s('general', 'woocommerce_store_postcode', 'Postcode / ZIP', 'text', ''),
  s('general', 'woocommerce_allowed_countries', 'Selling location(s)', 'select', 'all', { options: { all: 'Sell to all countries', all_except: 'Sell to all countries, except for…', specific: 'Sell to specific countries' } }),
  s('general', 'woocommerce_all_except_countries', 'Sell to all countries, except for…', 'multiselect', []),
  s('general', 'woocommerce_specific_allowed_countries', 'Sell to specific countries', 'multiselect', []),
  s('general', 'woocommerce_ship_to_countries', 'Shipping location(s)', 'select', '', { options: { '': 'Ship to all countries you sell to', all: 'Ship to all countries', specific: 'Ship to specific countries only', disabled: 'Disable shipping & shipping calculations' } }),
  s('general', 'woocommerce_specific_ship_to_countries', 'Ship to specific countries', 'multiselect', []),
  s('general', 'woocommerce_default_customer_address', 'Default customer location', 'select', 'base', { options: { '': 'No location by default', base: 'Shop country/region', geolocation: 'Geolocate' } }),
  s('general', 'woocommerce_calc_taxes', 'Enable taxes', 'checkbox', 'no'),
  s('general', 'woocommerce_enable_coupons', 'Enable coupons', 'checkbox', 'yes'),
  s('general', 'woocommerce_calc_discounts_sequentially', 'Calculate coupon discounts sequentially', 'checkbox', 'no'),
  s('general', 'woocommerce_currency', 'Currency', 'select', 'USD'),
  s('general', 'woocommerce_currency_pos', 'Currency position', 'select', 'left', { options: { left: 'Left', right: 'Right', left_space: 'Left with space', right_space: 'Right with space' } }),
  s('general', 'woocommerce_price_thousand_sep', 'Thousand separator', 'text', ','),
  s('general', 'woocommerce_price_decimal_sep', 'Decimal separator', 'text', '.'),
  s('general', 'woocommerce_price_num_decimals', 'Number of decimals', 'number', '2'),

  // Products
  s('products', 'woocommerce_shop_page_id', 'Shop page', 'single_select_page', ''),
  s('products', 'woocommerce_cart_redirect_after_add', 'Redirect to the cart page after successful addition', 'checkbox', 'no'),
  s('products', 'woocommerce_enable_ajax_add_to_cart', 'Enable AJAX add to cart buttons on archives', 'checkbox', 'yes'),
  s('products', 'woocommerce_placeholder_image', 'Placeholder image', 'text', ''),
  s('products', 'woocommerce_weight_unit', 'Weight unit', 'select', 'kg', { options: { kg: 'kg', g: 'g', lbs: 'lbs', oz: 'oz' } }),
  s('products', 'woocommerce_dimension_unit', 'Dimensions unit', 'select', 'cm', { options: { m: 'm', cm: 'cm', mm: 'mm', in: 'in', yd: 'yd' } }),
  s('products', 'woocommerce_enable_reviews', 'Enable product reviews', 'checkbox', 'yes'),
  s('products', 'woocommerce_review_rating_verification_label', 'Show "verified owner" label', 'checkbox', 'yes'),
  s('products', 'woocommerce_review_rating_verification_required', 'Reviews can only be left by "verified owners"', 'checkbox', 'no'),
  s('products', 'woocommerce_enable_review_rating', 'Enable star rating on reviews', 'checkbox', 'yes'),
  s('products', 'woocommerce_review_rating_required', 'Star ratings should be required', 'checkbox', 'yes'),
  s('products', 'woocommerce_manage_stock', 'Enable stock management', 'checkbox', 'yes'),
  s('products', 'woocommerce_hold_stock_minutes', 'Hold stock (minutes)', 'number', '60'),
  s('products', 'woocommerce_notify_low_stock', 'Enable low stock notifications', 'checkbox', 'yes'),
  s('products', 'woocommerce_notify_no_stock', 'Enable out of stock notifications', 'checkbox', 'yes'),
  s('products', 'woocommerce_stock_email_recipient', 'Notification recipient(s)', 'text', ''),
  s('products', 'woocommerce_notify_low_stock_amount', 'Low stock threshold', 'number', '2'),
  s('products', 'woocommerce_notify_no_stock_amount', 'Out of stock threshold', 'number', '0'),
  s('products', 'woocommerce_hide_out_of_stock_items', 'Hide out of stock items from the catalog', 'checkbox', 'no'),
  s('products', 'woocommerce_stock_format', 'Stock display format', 'select', '', { options: { '': 'Always show quantity remaining in stock', low_amount: 'Only show quantity remaining in stock when low', no_amount: 'Never show quantity remaining in stock' } }),
  s('products', 'woocommerce_file_download_method', 'File download method', 'select', 'force'),
  s('products', 'woocommerce_downloads_require_login', 'Downloads require login', 'checkbox', 'no'),
  s('products', 'woocommerce_downloads_grant_access_after_payment', 'Grant access to downloadable products after payment', 'checkbox', 'yes'),

  // Tax
  s('tax', 'woocommerce_prices_include_tax', 'Prices entered with tax', 'radio', 'no', { options: { yes: 'Yes, I will enter prices inclusive of tax', no: 'No, I will enter prices exclusive of tax' } }),
  s('tax', 'woocommerce_tax_based_on', 'Calculate tax based on', 'select', 'shipping', { options: { shipping: 'Customer shipping address', billing: 'Customer billing address', base: 'Shop base address' } }),
  s('tax', 'woocommerce_shipping_tax_class', 'Shipping tax class', 'select', 'inherit'),
  s('tax', 'woocommerce_tax_round_at_subtotal', 'Round tax at subtotal level, instead of rounding per line', 'checkbox', 'no'),
  s('tax', 'woocommerce_tax_classes', 'Additional tax classes', 'textarea', ''),
  s('tax', 'woocommerce_tax_display_shop', 'Display prices in the shop', 'select', 'excl', { options: { incl: 'Including tax', excl: 'Excluding tax' } }),
  s('tax', 'woocommerce_tax_display_cart', 'Display prices during cart and checkout', 'select', 'excl', { options: { incl: 'Including tax', excl: 'Excluding tax' } }),
  s('tax', 'woocommerce_price_display_suffix', 'Price display suffix', 'text', ''),
  s('tax', 'woocommerce_tax_total_display', 'Display tax totals', 'select', 'itemized', { options: { single: 'As a single total', itemized: 'Itemized' } }),

  // Shipping
  s('shipping', 'woocommerce_enable_shipping_calc', 'Enable the shipping calculator on the cart page', 'checkbox', 'yes'),
  s('shipping', 'woocommerce_shipping_cost_requires_address', 'Hide shipping costs until an address is entered', 'checkbox', 'no'),
  s('shipping', 'woocommerce_ship_to_destination', 'Shipping destination', 'radio', 'billing', { options: { shipping: 'Default to customer shipping address', billing: 'Default to customer billing address', billing_only: 'Force shipping to the customer billing address' } }),
  s('shipping', 'woocommerce_shipping_debug_mode', 'Enable debug mode', 'checkbox', 'no'),

  // Checkout / Payments
  s('checkout', 'woocommerce_enable_guest_checkout', 'Allow customers to place orders without an account', 'checkbox', 'yes'),
  s('checkout', 'woocommerce_enable_checkout_login_reminder', 'Allow customers to log into an existing account during checkout', 'checkbox', 'no'),
  s('checkout', 'woocommerce_cart_page_id', 'Cart page', 'single_select_page', ''),
  s('checkout', 'woocommerce_checkout_page_id', 'Checkout page', 'single_select_page', ''),
  s('checkout', 'woocommerce_terms_page_id', 'Terms and conditions', 'single_select_page', ''),
  s('checkout', 'woocommerce_force_ssl_checkout', 'Force secure checkout', 'checkbox', 'no'),

  // Accounts
  s('account', 'woocommerce_myaccount_page_id', 'My account page', 'single_select_page', ''),
  s('account', 'woocommerce_enable_signup_and_login_from_checkout', 'Allow customers to create an account during checkout', 'checkbox', 'no'),
  s('account', 'woocommerce_enable_myaccount_registration', 'Allow customers to create an account on the "My account" page', 'checkbox', 'no'),
  s('account', 'woocommerce_registration_generate_username', 'When creating an account, automatically generate an account username', 'checkbox', 'yes'),
  s('account', 'woocommerce_registration_generate_password', 'When creating an account, send the new user a link to set their password', 'checkbox', 'yes'),
  s('account', 'woocommerce_erasure_request_removes_order_data', 'Remove personal data from orders on request', 'checkbox', 'no'),
  s('account', 'woocommerce_allow_bulk_remove_personal_data', 'Allow personal data to be removed in bulk from orders', 'checkbox', 'no'),
  s('account', 'woocommerce_registration_privacy_policy_text', 'Registration privacy policy', 'textarea', 'Your personal data will be used to support your experience throughout this website, to manage access to your account, and for other purposes described in our [privacy_policy].'),
  s('account', 'woocommerce_checkout_privacy_policy_text', 'Checkout privacy policy', 'textarea', 'Your personal data will be used to process your order, support your experience throughout this website, and for other purposes described in our [privacy_policy].'),

  // Emails
  s('email', 'woocommerce_email_from_name', '"From" name', 'text', ''),
  s('email', 'woocommerce_email_from_address', '"From" address', 'email', ''),
  s('email', 'woocommerce_email_header_image', 'Header image', 'text', ''),
  s('email', 'woocommerce_email_footer_text', 'Footer text', 'textarea', '{site_title} &mdash; Built with {WooCommerce}'),
  s('email', 'woocommerce_email_base_color', 'Base color', 'color', '#7f54b3'),
  s('email', 'woocommerce_email_background_color', 'Background color', 'color', '#f7f7f7'),
  s('email', 'woocommerce_email_body_background_color', 'Body background color', 'color', '#ffffff'),
  s('email', 'woocommerce_email_text_color', 'Body text color', 'color', '#3c3c3c'),

  // Advanced
  s('advanced', 'woocommerce_checkout_pay_endpoint', 'Pay', 'text', 'order-pay'),
  s('advanced', 'woocommerce_checkout_order_received_endpoint', 'Order received', 'text', 'order-received'),
  s('advanced', 'woocommerce_myaccount_orders_endpoint', 'Orders', 'text', 'orders'),
  s('advanced', 'woocommerce_api_enabled', 'Enable the legacy REST API', 'checkbox', 'no'),

  // Analytics (WooCommerce → Analytics → Settings)
  s('analytics', 'woocommerce_excluded_report_order_statuses', 'Excluded statuses', 'multiselect', ['pending', 'failed', 'cancelled'], { description: 'Orders with these statuses are excluded from all reports.' }),
  s('analytics', 'woocommerce_actionable_order_statuses', 'Actionable statuses', 'multiselect', ['processing', 'on-hold'], { description: 'Orders with these statuses need attention from a store manager.' }),
  s('analytics', 'woocommerce_default_date_range', 'Default date range', 'select', 'period=month&compare=previous_period', {
    options: {
      'period=today&compare=previous_period': 'Today', 'period=week&compare=previous_period': 'Week to date', 'period=month&compare=previous_period': 'Month to date',
      'period=quarter&compare=previous_period': 'Quarter to date', 'period=year&compare=previous_period': 'Year to date', 'period=last_month&compare=previous_year': 'Last month vs previous year',
    },
  }),

  // WordPress core
  s('wp', 'blogname', 'Site Title', 'text', 'My Store'),
  s('wp', 'blogdescription', 'Tagline', 'text', ''),
  s('wp', 'admin_email', 'Administration Email Address', 'email', ''),
  s('wp', 'timezone_string', 'Timezone', 'text', 'UTC'),
  s('wp', 'gmt_offset', 'GMT offset (hours)', 'number', '0'),
  s('wp', 'date_format', 'Date Format', 'text', 'F j, Y'),
  s('wp', 'time_format', 'Time Format', 'text', 'g:i a'),
  s('wp', 'start_of_week', 'Week Starts On', 'number', '1'),
  s('wp', 'WPLANG', 'Site Language', 'text', ''),
  s('wp', 'posts_per_page', 'Blog pages show at most', 'number', '10'),
  s('wp', 'show_on_front', 'Your homepage displays', 'select', 'posts', { options: { posts: 'Your latest posts', page: 'A static page' } }),
  s('wp', 'page_on_front', 'Homepage', 'single_select_page', '0'),
  s('wp', 'page_for_posts', 'Posts page', 'single_select_page', '0'),
  s('wp', 'default_comment_status', 'Allow people to submit comments on new posts', 'select', 'open'),
  s('wp', 'permalink_structure', 'Permalink structure', 'text', '/%postname%/'),
  s('wp', 'site_logo', 'Site logo (media ID)', 'number', '0'),
  s('wp', 'site_icon', 'Site icon (media ID)', 'number', '0'),
];

for (const x of settings) {
  if (x.type === 'checkbox' && !x.options) x.options = yesno;
}

const byId = new Map(settings.map((x) => [x.id, x]));

module.exports = { groups, settings, byId };
