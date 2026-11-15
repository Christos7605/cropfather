import React from 'react';
import { useNavigate } from 'react-router-dom';
import { LayoutDashboard, MapPin, Target, Tractor, ClipboardList } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { FARM_QUESTIONNAIRE, loadFarmResponse, saveFarmResponse } from '../lib/questionnaire';
import { QuestionnaireWizard, secondaryBtn } from '../components/questionnaire/QuestionnaireWizard';

const SECTION_ICONS = { goals: Target, farm: Tractor };

// Questions about the farmer and the farm, answered once for all fields
export const FarmProfile: React.FC = () => {
  const { t } = useLanguage();
  const navigate = useNavigate();

  return (
    <QuestionnaireWizard
      def={FARM_QUESTIONNAIRE}
      load={loadFarmResponse}
      save={saveFarmResponse}
      icon={Tractor}
      sectionIcons={SECTION_ICONS}
      title={t('farmProfile.title')}
      intro={t('farmProfile.intro')}
      privacy={t('farmProfile.privacy')}
      back={{ to: '/dashboard', label: t('farmProfile.back') }}
      doneDesc={t('farmProfile.doneDesc')}
      doneActions={(review) => (
        <>
          <button
            type="button"
            onClick={() => navigate('/map')}
            className="cf-btn-primary px-5 py-3 rounded-lg text-sm flex items-center justify-center gap-2"
          >
            <MapPin className="w-4 h-4" />
            {t('farmProfile.toMap')}
          </button>
          <button type="button" onClick={() => navigate('/dashboard')} className={secondaryBtn}>
            <LayoutDashboard className="w-4 h-4" />
            {t('farmProfile.toDashboard')}
          </button>
          <button type="button" onClick={review} className={secondaryBtn}>
            <ClipboardList className="w-4 h-4" />
            {t('questionnaire.review')}
          </button>
        </>
      )}
    />
  );
};