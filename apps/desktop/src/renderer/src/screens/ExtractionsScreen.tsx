import { Page } from '../components/Page';
import { SiteImportWorkspace } from '../components/SiteImportDialog';
import { EXTRACTIONS_NAV_LABEL } from '../labels';

/**
 * The workspace's saved extractions, accessible independently of the asset and inbox screens.
 * New extractions target the inbox; saved tasks retain their captured destinations.
 *
 * @returns the shared extraction workspace as a regular page
 */
export function ExtractionsScreen() {
  return (
    <Page title={EXTRACTIONS_NAV_LABEL}>
      <SiteImportWorkspace presentation="page" target={null} />
    </Page>
  );
}
