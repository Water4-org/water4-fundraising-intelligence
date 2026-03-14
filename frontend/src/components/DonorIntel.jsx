import { useState, useMemo } from 'react'
import { formatCurrency, formatDate, classifyTier, daysSince } from '../utils/tiers.js'
import { STAGES, updateStage, updatePipelineInfo, logAsk, logMeaningfulConversation } from '../utils/api.js'
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'

const SORT_OPTIONS = [
  { id: 'ai_score',         label: 'AI Score'         },
  { id: 'lapse_risk',       label: 'Lapse Risk'       },
  { id: 'upgrade_prop',     label: 'Upgrade Propensity'},
  { id: 'total_giving',     label: 'Total Giving'     },
  { id: 'giving_this_fy',   label: 'This FY'          },
  { id: 'last_gift_date',   label: 'Last Gift'        },
]

function ScorePill({ value, invert = false, size = 'sm' }) {
  if (value === null || value === undefined) return <span className="text-gray-300 text-xs">—</span>
  const n = Number(value)
  const pct = invert ? (1 - n) * 100 : n > 1 ? n : n * 100
  const color = pct >= 70 ? (invert ? 'bg-red-500' : 'bg-emerald-500')
              : pct >= 40 ? 'bg-amber-500'
              : (invert ? 'bg-emerald-500' : 'bg-red-400')
  const label = n > 1 ? `${Math.round(n)}` : `${Math.round(n * 100)}%`
  return (
    <span className={`inline-flex items-center gap-1 text-white text-xs font-semibold px-2 py-0.5 rounded-full ${color}`}>
      {label}
    </span>
  )
}

function RFMBadge({ r, f, m }) {
  if (!r && !f && !m) return null
  return (
    <span className="inline-flex gap-1 text-xs font-mono text-gray-500">
      <span title="Recency"   className="bg-gray-100 px-1.5 rounded">R{r ?? '?'}</span>
      <span title="Frequency" className="bg-gray-100 px-1.5 rounded">F{f ?? '?'}</span>
      <span title="Monetary"  className="bg-gray-100 px-1.5 rounded">M{m ?? '?'}</span>
    </span>
  )
}

export default function DonorIntel({ donors, currentUser }) {
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('ai_score')
  const [tierFilter, setTierFilter] = useState('all')
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState(null)
  const PAGE_SIZE = 25

  const filtered = useMemo(() => {
    let list = donors
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(d =>
        d.full_name?.toLowerCase().includes(q) ||
        d.email?.toLowerCase().includes(q) ||
        d.city?.toLowerCase().includes(q)
      )
    }
    if (tierFilter !== 'all') {
      list = list.filter(d => {
        const tier = classifyTier(Math.max(d.giving_this_fy || 0, d.giving_last_fy || 0))
        return tier.id === tierFilter
      })
    }
    return [...list].sort((a, b) => {
      switch (sortBy) {
        case 'ai_score':       return (b.ai_score || 0) - (a.ai_score || 0)
        case 'lapse_risk':     return (b.lapse_risk || 0) - (a.lapse_risk || 0)
        case 'upgrade_prop':   return (b.upgrade_propensity || 0) - (a.upgrade_propensity || 0)
        case 'total_giving':   return (b.total_giving || 0) - (a.total_giving || 0)
        case 'giving_this_fy': return (b.giving_this_fy || 0) - (a.giving_this_fy || 0)
        case 'last_gift_date': return (b.last_gift_date || '').localeCompare(a.last_gift_date || '')
        default: return 0
      }
    })
  }, [donors, search, sortBy, tierFilter])

  const pages = Math.ceil(filtered.length / PAGE_SIZE)
  const shown = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <div>
      {/* Controls */}
      <div className="flex flex-wrap gap-3 mb-5">
        <input
          type="search"
          placeholder="Search donors..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0) }}
          className="flex-1 min-w-48 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-teal"
        />
        <select
          value={tierFilter}
          onChange={e => { setTierFilter(e.target.value); setPage(0) }}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:border-teal"
        >
          <option value="all">All Tiers</option>
          {['transformational','leadership','major','mid_level','donor','prospect'].map(t => (
            <option key={t} value={t}>{t.replace('_', '-')}</option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:border-teal"
        >
          {SORT_OPTIONS.map(o => (
            <option key={o.id} value={o.id}>Sort: {o.label}</option>
          ))}
        </select>
      </div>

      <p className="text-xs text-gray-400 mb-3">
        {filtered.length} donors {search || tierFilter !== 'all' ? '(filtered)' : ''}
      </p>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Donor</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Tier</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">This FY</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Last Gift</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">AI Score</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Lapse Risk</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Upgrade</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">RFM</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Ask</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {shown.map(donor => {
                const tier = classifyTier(Math.max(donor.giving_this_fy || 0, donor.giving_last_fy || 0))
                const isExpanded = expanded === donor.sf_id
                return [
                  <tr
                    key={donor.sf_id}
                    className="hover:bg-gray-50 cursor-pointer transition-colors"
                    onClick={() => setExpanded(isExpanded ? null : donor.sf_id)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-gray-800">{donor.full_name}</span>
                        <EntityBadge entityType={donor.entity_type} primaryAffiliation={donor.primary_affiliation} />
                      </div>
                      {donor.gift_officer && (
                        <div className="text-xs text-gray-400">{donor.gift_officer}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${tier.bg} ${tier.text} ${tier.border}`}>
                        {tier.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-800">
                      {formatCurrency(donor.giving_this_fy, true)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500 text-xs">
                      {donor.last_gift_date ? `${daysSince(donor.last_gift_date)}d ago` : '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <ScorePill value={donor.ai_score} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <ScorePill value={donor.lapse_risk} invert />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <ScorePill value={donor.upgrade_propensity} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <RFMBadge r={donor.rfm_recency} f={donor.rfm_frequency} m={donor.rfm_monetary} />
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-teal text-xs">
                      {donor.ask_amount ? formatCurrency(donor.ask_amount, true) : '—'}
                    </td>
                  </tr>,
                  isExpanded && (
                    <tr key={`${donor.sf_id}-exp`} className="bg-teal/5">
                      <td colSpan={9} className="px-4 py-4">
                        <DonorDetail donor={donor} currentUser={currentUser} />
                      </td>
                    </tr>
                  )
                ]
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:border-teal transition-colors"
          >
            ←
          </button>
          <span className="text-sm text-gray-500">Page {page + 1} of {pages}</span>
          <button
            onClick={() => setPage(p => Math.min(pages - 1, p + 1))}
            disabled={page === pages - 1}
            className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:border-teal transition-colors"
          >
            →
          </button>
        </div>
      )}
    </div>
  )
}

function EntityBadge({ entityType, primaryAffiliation }) {
  if (!entityType || entityType === 'individual') return null
  if (entityType === 'organization') {
    return (
      <span className="inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700 border border-blue-200" title="Organization Account">
        ORG
      </span>
    )
  }
  if (entityType === 'affiliated_individual') {
    return (
      <span className="inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-700 border border-purple-200" title={primaryAffiliation || 'Has organizational affiliations'}>
        {primaryAffiliation || 'AFFILIATED'}
      </span>
    )
  }
  return null
}

const MEANINGFUL_CONVERSATION_OPTIONS = [
  'Face to Face',
  'Conversation Longer Than 10 Minutes',
  'Verbal Commitment',
  'Referrals',
  'Founders Club Invite',
  'Headquarter Tour',
  'Log / Made an Ask with amount',
]

const ASK_TYPES = ['Annual', 'Major Gift', 'Planned Gift', 'Capital Campaign', 'Event Sponsorship', 'Corporate Partnership', 'Grant', 'Other']
const CONFIDENCE_LEVELS = ['Very High', 'High', 'Medium', 'Low', 'Very Low']
const DONOR_TYPES = ['Individual', 'Organization', 'Foundation', 'Corporation', 'Church', 'Government', 'Other']
const ASK_STYLES = ['In Person', 'Phone Call', 'Video Call', 'Email', 'Written Proposal', 'Event', 'Other']

function DonorDetail({ donor, currentUser }) {
  const [stage, setStage] = useState(donor.stage || '')
  const [pendingStage, setPendingStage] = useState(stage)
  const [stageNotes, setStageNotes] = useState('')
  const [stageSaving, setStageSaving] = useState(false)
  const [stageError, setStageError] = useState(null)
  const [stageSaved, setStageSaved] = useState(false)

  // Pipeline Information fields
  const [stageEntryDate, setStageEntryDate] = useState(donor.stage_entry_date || '')
  const [actionPlanDate, setActionPlanDate] = useState(donor.current_action_plan_date || '')
  const [currentActionPlan, setCurrentActionPlan] = useState(donor.current_action_plan || '')
  const [previousActionPlan, setPreviousActionPlan] = useState(donor.previous_action_plan || '')
  const [pipelineSaving, setPipelineSaving] = useState(false)
  const [pipelineError, setPipelineError] = useState(null)
  const [pipelineSaved, setPipelineSaved] = useState(false)

  const pipelineChanged =
    stageEntryDate !== (donor.stage_entry_date || '') ||
    actionPlanDate !== (donor.current_action_plan_date || '') ||
    currentActionPlan !== (donor.current_action_plan || '') ||
    previousActionPlan !== (donor.previous_action_plan || '')

  // Log An Ask form
  const [showAskForm, setShowAskForm] = useState(false)
  const [askForm, setAskForm] = useState({
    amount_requested: '',
    due_date: '',
    ask_type: '',
    contact_name: donor.full_name || '',
    confidence_level: '',
    organization_name: '',
    donor_type: '',
    style_of_ask: '',
    comments: '',
  })
  const [askSaving, setAskSaving] = useState(false)
  const [askError, setAskError] = useState(null)
  const [askSaved, setAskSaved] = useState(false)

  const stageChanged = pendingStage !== stage

  async function handleSaveStage() {
    if (!stageChanged) return
    setStageSaving(true)
    setStageError(null)
    setStageSaved(false)
    try {
      await updateStage(donor.account_id, pendingStage, stageNotes, currentUser?.sf_user_id, donor.sf_id)
      setStage(pendingStage)
      setStageNotes('')
      setStageSaved(true)
      setTimeout(() => setStageSaved(false), 3000)
    } catch (e) {
      setStageError(e.message || 'Save failed')
    } finally {
      setStageSaving(false)
    }
  }

  async function handleSavePipelineInfo() {
    setPipelineSaving(true)
    setPipelineError(null)
    setPipelineSaved(false)
    try {
      await updatePipelineInfo(donor.account_id, {
        stage_entry_date: stageEntryDate,
        current_action_plan_date: actionPlanDate,
        current_action_plan: currentActionPlan,
        previous_action_plan: previousActionPlan,
      }, currentUser?.sf_user_id)
      setPipelineSaved(true)
      setTimeout(() => setPipelineSaved(false), 3000)
    } catch (e) {
      setPipelineError(e.message || 'Save failed')
    } finally {
      setPipelineSaving(false)
    }
  }

  async function handleLogAsk() {
    if (!askForm.amount_requested) {
      setAskError('Amount Requested is required')
      return
    }
    setAskSaving(true)
    setAskError(null)
    setAskSaved(false)
    try {
      await logAsk({
        account_id: donor.account_id,
        donor_sf_id: donor.sf_id,
        owner_sf_id: currentUser?.sf_user_id,
        ...askForm,
        amount_requested: parseFloat(askForm.amount_requested) || 0,
      })
      setAskSaved(true)
      setShowAskForm(false)
      setAskForm({
        amount_requested: '',
        due_date: '',
        ask_type: '',
        contact_name: donor.full_name || '',
        confidence_level: '',
        organization_name: '',
        donor_type: '',
        style_of_ask: '',
        comments: '',
      })
      setTimeout(() => setAskSaved(false), 3000)
    } catch (e) {
      setAskError(e.message || 'Save failed')
    } finally {
      setAskSaving(false)
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {donor.ai_narrative && (
        <div className="md:col-span-2 bg-white rounded-lg p-3 border border-teal/20">
          <p className="text-xs font-semibold text-teal/70 uppercase tracking-wider mb-1">AI Donor Portrait</p>
          <p className="text-sm text-gray-700 leading-relaxed">{donor.ai_narrative}</p>
        </div>
      )}

      {/* Donor Profile Radar + Engagement + Giving Comparison */}
      <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Radar chart */}
        <div className="bg-white rounded-lg p-3 border border-gray-200">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Donor Profile</p>
          <ResponsiveContainer width="100%" height={200}>
            <RadarChart data={[
              { metric: 'AI Score',  value: Math.min((donor.ai_score || 0), 100), fullMark: 100 },
              { metric: 'Retention', value: Math.round((1 - (donor.lapse_risk || 0)) * 100), fullMark: 100 },
              { metric: 'Upgrade',   value: Math.round((donor.upgrade_propensity || 0) * 100), fullMark: 100 },
              { metric: 'Recency',   value: (donor.rfm_recency || 0) * 20, fullMark: 100 },
              { metric: 'Frequency', value: (donor.rfm_frequency || 0) * 20, fullMark: 100 },
              { metric: 'Monetary',  value: (donor.rfm_monetary || 0) * 20, fullMark: 100 },
            ]}>
              <PolarGrid stroke="#e5e7eb" />
              <PolarAngleAxis dataKey="metric" tick={{ fontSize: 10, fill: '#6b7280' }} />
              <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
              <Radar dataKey="value" stroke="#1B4D5C" fill="#1B4D5C" fillOpacity={0.25} strokeWidth={2} />
            </RadarChart>
          </ResponsiveContainer>
        </div>

        {/* Engagement Score */}
        <div className="bg-white rounded-lg p-3 border border-gray-200">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Engagement Score</p>
          {(() => {
            const score = donor.ai_score || 0
            const lapse = donor.lapse_risk || 0
            const upgrade = donor.upgrade_propensity || 0
            const engagement = Math.round(score * 0.4 + (1 - lapse) * 100 * 0.3 + upgrade * 100 * 0.3)
            const color = engagement >= 70 ? '#059669' : engagement >= 40 ? '#D97706' : '#EF4444'
            const ringPct = Math.min(engagement, 100)
            return (
              <div className="flex flex-col items-center">
                <div className="relative w-28 h-28">
                  <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                    <circle cx="50" cy="50" r="42" fill="none" stroke="#f3f4f6" strokeWidth="8" />
                    <circle cx="50" cy="50" r="42" fill="none" stroke={color} strokeWidth="8"
                      strokeDasharray={`${ringPct * 2.64} 264`} strokeLinecap="round" />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-2xl font-bold" style={{ color }}>{engagement}</span>
                  </div>
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  {engagement >= 70 ? 'Highly Engaged' : engagement >= 40 ? 'Moderately Engaged' : 'Low Engagement'}
                </p>
                <div className="mt-3 w-full space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-gray-500">AI Score</span><span className="font-semibold">{score}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Lapse Risk</span><span className="font-semibold">{(lapse * 100).toFixed(0)}%</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Upgrade</span><span className="font-semibold">{(upgrade * 100).toFixed(0)}%</span></div>
                  {donor.days_since_last_gift != null && (
                    <div className="flex justify-between"><span className="text-gray-500">Days Since Gift</span><span className="font-semibold">{donor.days_since_last_gift ?? daysSince(donor.last_gift_date) ?? '—'}</span></div>
                  )}
                </div>
              </div>
            )
          })()}
        </div>

        {/* Giving Comparison + Next Ask */}
        <div className="bg-white rounded-lg p-3 border border-gray-200 flex flex-col">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Giving Comparison</p>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={[
              { name: 'Last FY', value: donor.giving_last_fy || 0 },
              { name: 'This FY', value: donor.giving_this_fy || 0 },
              ...(donor.ask_amount ? [{ name: 'Next Ask', value: donor.ask_amount }] : []),
            ]}>
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => formatCurrency(v, true)} width={50} />
              <Tooltip formatter={v => formatCurrency(v)} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                <Cell fill="#94A3B8" />
                <Cell fill="#1B4D5C" />
                {donor.ask_amount && <Cell fill="#C4963E" />}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {donor.ask_amount && (
            <div className="mt-auto pt-3 border-t border-gray-100">
              <div className="bg-gold/10 rounded-lg p-2.5 border border-gold/20">
                <p className="text-xs font-semibold text-gold uppercase tracking-wider mb-0.5">Recommended Ask</p>
                <p className="text-lg font-bold text-gray-800">{formatCurrency(donor.ask_amount)}</p>
                {donor.ask_rationale && (
                  <p className="text-xs text-gray-500 mt-1">{donor.ask_rationale}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Ask Rationale */}
      {(donor.ask_rationale || donor.ask_amount) && (
        <div className="md:col-span-2 bg-white rounded-lg p-3 border border-teal/20">
          <p className="text-xs font-semibold text-teal/70 uppercase tracking-wider mb-1">AI Recommendation</p>
          {donor.ask_amount && (
            <p className="text-sm font-bold text-teal mb-1">
              Recommended ask: {formatCurrency(donor.ask_amount)}
            </p>
          )}
          {donor.ask_rationale && (
            <p className="text-sm text-gray-700">{donor.ask_rationale}</p>
          )}
        </div>
      )}

      {/* Pipeline Stage */}
      <div className="md:col-span-2 bg-white rounded-lg p-3 border border-gray-200">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Pipeline Stage</p>
        <div className="flex flex-wrap items-start gap-2">
          <select
            value={pendingStage}
            onChange={e => { setPendingStage(e.target.value); setStageSaved(false) }}
            disabled={stageSaving}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:border-teal disabled:opacity-50"
          >
            <option value="">— No stage set —</option>
            {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {stageChanged && (
            <>
              <input
                type="text"
                placeholder="Notes (optional)"
                value={stageNotes}
                onChange={e => setStageNotes(e.target.value)}
                disabled={stageSaving}
                className="flex-1 min-w-32 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-teal disabled:opacity-50"
              />
              <button
                onClick={handleSaveStage}
                disabled={stageSaving}
                className="text-sm bg-teal text-white px-3 py-1.5 rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {stageSaving ? 'Saving...' : 'Save to Salesforce'}
              </button>
            </>
          )}
          {stageSaved && !stageChanged && (
            <span className="text-xs text-emerald-600 font-medium self-center">Saved</span>
          )}
        </div>
        {stageError && <p className="text-xs text-red-600 mt-1">{stageError}</p>}
      </div>

      {/* Pipeline Information — Feature 1 */}
      <div className="md:col-span-2 bg-white rounded-lg p-3 border border-blue-200">
        <p className="text-xs font-semibold text-blue-600 uppercase tracking-wider mb-3">Pipeline Information</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Stage Entry Date</label>
            <input
              type="date"
              value={stageEntryDate}
              onChange={e => { setStageEntryDate(e.target.value); setPipelineSaved(false) }}
              disabled={pipelineSaving}
              className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:border-blue-400 disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Current Action Plan Date</label>
            <input
              type="date"
              value={actionPlanDate}
              onChange={e => { setActionPlanDate(e.target.value); setPipelineSaved(false) }}
              disabled={pipelineSaving}
              className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:border-blue-400 disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Current Action Plan</label>
            <textarea
              value={currentActionPlan}
              onChange={e => { setCurrentActionPlan(e.target.value); setPipelineSaved(false) }}
              disabled={pipelineSaving}
              rows={3}
              placeholder="Current action plan..."
              className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:border-blue-400 disabled:opacity-50 resize-none"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Previous Action Plan</label>
            <textarea
              value={previousActionPlan}
              onChange={e => { setPreviousActionPlan(e.target.value); setPipelineSaved(false) }}
              disabled={pipelineSaving}
              rows={3}
              placeholder="Previous action plan..."
              className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:border-blue-400 disabled:opacity-50 resize-none"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          {pipelineChanged && (
            <button
              onClick={handleSavePipelineInfo}
              disabled={pipelineSaving}
              className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {pipelineSaving ? 'Saving...' : 'Save Pipeline Info to Salesforce'}
            </button>
          )}
          {pipelineSaved && !pipelineChanged && (
            <span className="text-xs text-emerald-600 font-medium">Pipeline info saved</span>
          )}
        </div>
        {pipelineError && <p className="text-xs text-red-600 mt-1">{pipelineError}</p>}
      </div>

      {/* Log An Ask — Feature 2 */}
      <div className="md:col-span-2 bg-white rounded-lg p-3 border border-gold/30">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-gold uppercase tracking-wider">Log An Ask</p>
          {!showAskForm && (
            <button
              onClick={() => setShowAskForm(true)}
              className="text-xs bg-gold/10 text-gold border border-gold/30 px-3 py-1 rounded-lg font-medium hover:bg-gold/20 transition-colors"
            >
              + New Ask
            </button>
          )}
          {askSaved && !showAskForm && (
            <span className="text-xs text-emerald-600 font-medium">Ask logged successfully</span>
          )}
        </div>
        {showAskForm && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Amount Requested *</label>
                <input
                  type="number"
                  step="0.01"
                  value={askForm.amount_requested}
                  onChange={e => setAskForm(f => ({ ...f, amount_requested: e.target.value }))}
                  disabled={askSaving}
                  placeholder="0.00"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-gold disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Due Date</label>
                <input
                  type="date"
                  value={askForm.due_date}
                  onChange={e => setAskForm(f => ({ ...f, due_date: e.target.value }))}
                  disabled={askSaving}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-gold disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Ask Type</label>
                <select
                  value={askForm.ask_type}
                  onChange={e => setAskForm(f => ({ ...f, ask_type: e.target.value }))}
                  disabled={askSaving}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:border-gold disabled:opacity-50"
                >
                  <option value="">Select...</option>
                  {ASK_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Contact Name</label>
                <input
                  type="text"
                  value={askForm.contact_name}
                  onChange={e => setAskForm(f => ({ ...f, contact_name: e.target.value }))}
                  disabled={askSaving}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-gold disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Confidence Level</label>
                <select
                  value={askForm.confidence_level}
                  onChange={e => setAskForm(f => ({ ...f, confidence_level: e.target.value }))}
                  disabled={askSaving}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:border-gold disabled:opacity-50"
                >
                  <option value="">Select...</option>
                  {CONFIDENCE_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Organization Name</label>
                <input
                  type="text"
                  value={askForm.organization_name}
                  onChange={e => setAskForm(f => ({ ...f, organization_name: e.target.value }))}
                  disabled={askSaving}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-gold disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Donor Type</label>
                <select
                  value={askForm.donor_type}
                  onChange={e => setAskForm(f => ({ ...f, donor_type: e.target.value }))}
                  disabled={askSaving}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:border-gold disabled:opacity-50"
                >
                  <option value="">Select...</option>
                  {DONOR_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Style of Ask</label>
                <select
                  value={askForm.style_of_ask}
                  onChange={e => setAskForm(f => ({ ...f, style_of_ask: e.target.value }))}
                  disabled={askSaving}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:border-gold disabled:opacity-50"
                >
                  <option value="">Select...</option>
                  {ASK_STYLES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="md:col-span-3">
                <label className="block text-xs text-gray-500 mb-1">Comments</label>
                <textarea
                  value={askForm.comments}
                  onChange={e => setAskForm(f => ({ ...f, comments: e.target.value }))}
                  disabled={askSaving}
                  rows={2}
                  placeholder="Additional notes..."
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-gold disabled:opacity-50 resize-none"
                />
              </div>
            </div>
            {askError && <p className="text-xs text-red-600">{askError}</p>}
            <div className="flex gap-2">
              <button
                onClick={handleLogAsk}
                disabled={askSaving}
                className="text-sm bg-gold text-white px-3 py-1.5 rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {askSaving ? 'Saving...' : 'Log Ask to Salesforce'}
              </button>
              <button
                onClick={() => { setShowAskForm(false); setAskError(null) }}
                disabled={askSaving}
                className="text-sm border border-gray-200 text-gray-600 hover:border-gray-400 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Held Meaningful Conversation — Feature 3 */}
      <MeaningfulConversationSection donor={donor} currentUser={currentUser} />

      {/* Affiliations */}
      {donor.affiliations && donor.affiliations.length > 0 && (
        <div className="md:col-span-2 bg-white rounded-lg p-3 border border-purple-200">
          <p className="text-xs font-semibold text-purple-600 uppercase tracking-wider mb-2">
            Organizational Affiliations ({donor.affiliations.length})
          </p>
          <div className="space-y-1.5">
            {donor.affiliations.map((aff, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                {aff.primary && (
                  <span className="inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-700 border border-purple-200">PRIMARY</span>
                )}
                <span className="font-medium text-gray-700">{aff.role || 'Member'}</span>
                <span className="text-gray-400">at</span>
                <span className="font-medium text-gray-700">{aff.org_name || 'Unknown Org'}</span>
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${
                  aff.status?.toLowerCase() === 'current'
                    ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                    : 'bg-gray-100 text-gray-500 border-gray-200'
                }`}>
                  {aff.status || 'Unknown'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Activity History */}
      {donor.activities && donor.activities.length > 0 && (
        <div className="md:col-span-2 bg-white rounded-lg p-3 border border-gray-200">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Recent Activity ({donor.activities.length})
          </p>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {donor.activities.map((act, i) => (
              <div key={i} className="flex items-start gap-2 text-xs border-b border-gray-50 pb-1.5">
                <span className="shrink-0 mt-0.5">
                  {act.type === 'event' ? '📅' : act.subtype === 'Email' ? '✉️' : act.task_type === 'Call' ? '📞' : '📋'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-gray-700">{act.subject || 'No subject'}</span>
                    {act.held_meaningful_conversation && (
                      <span className="inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
                        {act.held_meaningful_conversation}
                      </span>
                    )}
                  </div>
                  <div className="text-gray-400">
                    {act.date && <span>{formatDate(act.date)}</span>}
                    {act.owner && <span> · {act.owner}</span>}
                    {act.status && act.status !== 'Completed' && <span> · {act.status}</span>}
                  </div>
                  {act.description && (
                    <p className="text-gray-500 mt-0.5 line-clamp-2">{act.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg p-3 border border-gray-200">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Giving Summary</p>
        <div className="space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-gray-500">Total lifetime</span>
            <span className="font-semibold">{formatCurrency(donor.total_giving)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">This FY</span>
            <span className="font-semibold">{formatCurrency(donor.giving_this_fy)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Last FY</span>
            <span className="font-semibold">{formatCurrency(donor.giving_last_fy)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Gift count</span>
            <span className="font-semibold">{donor.gift_count}</span>
          </div>
          {donor.is_recurring && (
            <div className="flex justify-between text-emerald-600">
              <span>Recurring ({donor.rd_period})</span>
              <span className="font-semibold">{formatCurrency(donor.rd_amount)}</span>
            </div>
          )}
        </div>
      </div>
      <div className="bg-white rounded-lg p-3 border border-gray-200">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Contact</p>
        <div className="space-y-1 text-xs text-gray-600">
          {donor.email && <p>{donor.email}</p>}
          {donor.phone && <p>{donor.phone}</p>}
          {(donor.city || donor.state) && (
            <p>{[donor.city, donor.state, donor.country].filter(Boolean).join(', ')}</p>
          )}
          <p className="text-gray-400">SF ID: {donor.sf_id}</p>
          {donor.last_analyzed && (
            <p className="text-gray-400">Analyzed: {formatDate(donor.last_analyzed)}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function MeaningfulConversationSection({ donor, currentUser }) {
  const [selected, setSelected] = useState([])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  function toggleOption(opt) {
    setSaved(false)
    setSelected(prev => prev.includes(opt) ? prev.filter(v => v !== opt) : [...prev, opt])
  }

  async function handleSave() {
    if (selected.length === 0) {
      setError('Please select at least one option')
      return
    }
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await logMeaningfulConversation({
        account_id: donor.account_id,
        donor_sf_id: donor.sf_id,
        owner_sf_id: currentUser?.sf_user_id,
        held_meaningful_conversation: selected.join(';'),
        notes,
      })
      setSaved(true)
      setSelected([])
      setNotes('')
      setTimeout(() => setSaved(false), 3000)
    } catch (e) {
      setError(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="md:col-span-2 bg-white rounded-lg p-3 border border-emerald-200">
      <p className="text-xs font-semibold text-emerald-600 uppercase tracking-wider mb-2">Held Meaningful Conversation</p>
      <div className="flex flex-wrap gap-2 mb-2">
        {MEANINGFUL_CONVERSATION_OPTIONS.map(opt => (
          <button
            key={opt}
            onClick={() => toggleOption(opt)}
            disabled={saving}
            className={`text-xs px-3 py-1.5 rounded-lg font-medium border transition-colors disabled:opacity-50 ${
              selected.includes(opt)
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'bg-white text-gray-600 border-gray-200 hover:border-emerald-400'
            }`}
          >
            {selected.includes(opt) && '✓ '}{opt}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <input
          type="text"
          placeholder="Notes (optional)"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          disabled={saving}
          className="flex-1 min-w-32 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-emerald-400 disabled:opacity-50"
        />
        <button
          onClick={handleSave}
          disabled={saving || selected.length === 0}
          className="text-sm bg-emerald-600 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-emerald-700 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Log to Salesforce'}
        </button>
        {saved && (
          <span className="text-xs text-emerald-600 font-medium self-center">Logged</span>
        )}
      </div>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  )
}
