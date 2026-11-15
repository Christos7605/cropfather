import type { FC } from 'react';
import logo from '../assets/CropFatherLogo_green.png';

/** Same bar on the home page and every signed-in page. Extra actions sit on the right. */
export const SITE_HEADER_CLASS =
  'cf-glass cf-header sticky top-0 z-30 border-b px-4 sm:px-8 py-3.5 flex items-center justify-between';

export const BrandMark: FC = () => (
  <div className="cf-glass-pill p-1.5 rounded-xl shrink-0">
    <img src={logo} alt="" width={24} height={24} className="w-6 h-6 object-contain" />
  </div>
);
