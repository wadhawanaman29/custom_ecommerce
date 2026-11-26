import { useNotice } from '../../hooks';
import SettingsForm from '../../components/SettingsForm';
import { Notice, PageHeader } from '../../components/ui';

// WordPress Settings → General / Reading (stored as wp_options-style options)
const SECTIONS = {
  general: {
    title: 'General Settings',
    ids: ['blogname', 'blogdescription', 'admin_email', 'timezone_string', 'gmt_offset', 'date_format', 'time_format', 'start_of_week', 'WPLANG', 'site_logo', 'site_icon', 'permalink_structure'],
  },
  reading: {
    title: 'Reading Settings',
    ids: ['show_on_front', 'page_on_front', 'page_for_posts', 'posts_per_page', 'default_comment_status'],
  },
};

export default function SiteSettings({ section }) {
  const cfg = SECTIONS[section];
  const [notice, showNotice, closeNotice] = useNotice();
  return (
    <>
      <PageHeader title={cfg.title} />
      <Notice notice={notice} onClose={closeNotice} />
      <SettingsForm group="wp" only={cfg.ids} onNotice={showNotice} />
      {section === 'general' && <p className="description">Site logo/icon take a media ID from the Media Library. GMT offset is used for all dates shown by the API.</p>}
    </>
  );
}
