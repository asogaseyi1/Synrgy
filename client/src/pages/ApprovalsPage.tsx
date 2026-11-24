import { useSearchParams } from 'react-router';
import { useCounts } from '../counts.ts';
import { ExceptionApprovals } from './ExceptionPages.tsx';
import { SwapApprovals } from './SwapPages.tsx';

export function ApprovalsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'swaps' ? 'swaps' : 'time';
  const counts = useCounts(true);

  return (
    <section>
      <div className="page-head">
        <div>
          <p className="eyebrow">Manager</p>
          <h1>Approvals</h1>
        </div>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'time'} className={tab === 'time' ? 'active' : ''} onClick={() => setParams({})}>
            Time corrections{counts.exceptions > 0 && <span className="count">{counts.exceptions}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'swaps'} className={tab === 'swaps' ? 'active' : ''} onClick={() => setParams({ tab: 'swaps' })}>
            Shift swaps{counts.swapReview > 0 && <span className="count">{counts.swapReview}</span>}
          </button>
        </div>
      </div>
      {tab === 'time' ? <ExceptionApprovals /> : <SwapApprovals />}
    </section>
  );
}
