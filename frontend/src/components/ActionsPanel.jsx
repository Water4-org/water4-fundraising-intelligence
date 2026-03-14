import { useState } from 'react'
import { formatCurrency, formatDate, daysSince, classifyTier } from '../utils/tiers.js'
import { completeAction, updateStage, STAGES } from '../utils/api.js'

const PRIORITY_LABEL = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low', 5: 'Routine' }
const PRIORITY_COLOR = {
  1: 'bg-red-100 text-red-700 border-red-200',
  2: 'bg-amber-100 text-amber-700 border-amber-200',
  3: 'bg-blue-100 text-blue-700 border-blue-200',
  4: 'bg-gray-100 text-gray-600 border-gray-200',
  5: 'bg-gray-100 text-gray-400 border-gray-200',
}
const ACTIVITY_ICON = {
  call:             '📞',
  meeting:          '🤝',
  email:            '✉️',
  handwritten_note: '✍️',
  impact_report:    '📊',
  field_visit:      '✈️',
  research:         '🔍',
}

export default function ActionsPanel({ actions, donors, currentUser }) {
  const [filter, setFilter] = useState('pending')
  const [expandedId, setExpandedId] = useState(null)
  const [completed, setCompleted] = useState(new Set())
  const [search, setSearch] = useState('')

  // Build quick lookups
  const donorStageMap = Object.fromEntries(
    (donors || []).map(d => [d.sf_id, d.stage || ''])
  )
  const donorMap = Object.fromEntries(
    (donors || []).map(d => [d.sf_id, d])
  )

  const pendingActions = actions.filter(a => a.status === 'pending' && !completed.has(a.action_id))
  const doneActions    = actions.filter(a => a.status !== 'pending' || completed.has(a.action_id))

  function sortByDate(arr) {
    return arr.slice().sort((a, b) => {
      if (!a.due_date) return 1
      if (!b.due_date) return -1
      return new Date(a.due_date) - new Date(b.due_date)
    })
  }

  const allBase = filter === 'pending' ? pendingActions : doneActions
  const base = search.trim()
    ? allBase.filter(a => {
        const q = search.trim().toLowerCase()
        return a.donor_name?.toLowerCase().includes(q)
            || a.gift_officer?.toLowerCase().includes(q)
            || a.label?.toLowerCase().includes(q)
            || a.reason?.toLowerCase().includes(q)
      })
    : allBase
  const officers = [...new Set(base.map(a => a.gift_officer).filter(Boolean))].sort()
  const multiOfficer = officers.length > 1

  // Group by officer, each group sorted by due_date
  const groups = multiOfficer
    ? officers.map(o => ({ officer: o, actions: sortByDate(base.filter(a => a.gift_officer === o)) }))
    : [{ officer: null, actions: sortByDate(base) }]

  // Summary stats
  const byPriority = [1, 2, 3, 4].map(p => ({
    p,
    count: pendingActions.filter(a => a.priority === p).length,
  }))

  const totalAsk = pendingActions
    .filter(a => a.action_type === 'upgrade_ask' && a.ask_amount)
    .reduce((s, a) => s + Number(a.ask_amount), 0)

  function markComplete(actionId) {
    setCompleted(prev => new Set([...prev, actionId]))
    if (expandedId === actionId) setExpandedId(null)
  }

  return (
    <div>
      {/* Summary bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {byPriority.map(({ p, count }) => (
          <div key={p} className="bg-white rounded-xl border border-gray-200 p-4">
            <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border mb-2 ${PRIORITY_COLOR[p]}`}>
              {PRIORITY_LABEL[p]}
            </div>
            <div className="text-2xl font-bold text-gray-800">{count}</div>
            <div className="text-xs text-gray-400">actions pending</div>
          </div>
        ))}
      </div>

      {totalAsk > 0 && (
        <div className="bg-teal/5 border border-teal/20 rounded-xl p-4 mb-6 flex items-center gap-3">
          <span className="text-teal text-2xl">💡</span>
          <div>
            <p className="text-sm font-semibold text-teal">Upgrade asks in queue</p>
            <p className="text-xs text-teal/70">
              {pendingActions.filter(a => a.action_type === 'upgrade_ask').length} donors ready for upgrade asks
              totaling <span className="font-bold">{formatCurrency(totalAsk)}</span> in potential new commitments
            </p>
          </div>
        </div>
      )}

      {/* Search + Filter */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          type="search"
          placeholder="Search by donor, officer, or activity..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-48 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-teal"
        />
      </div>

      {/* Filter toggle */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => setFilter('pending')}
          className={`text-sm px-3 py-1.5 rounded-lg font-medium transition-colors
            ${filter === 'pending' ? 'bg-teal text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-teal'}`}
        >
          Pending ({pendingActions.length})
        </button>
        <button
          onClick={() => setFilter('done')}
          className={`text-sm px-3 py-1.5 rounded-lg font-medium transition-colors
            ${filter === 'done' ? 'bg-teal text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-teal'}`}
        >
          Completed ({doneActions.length})
        </button>
      </div>

      {/* Action list */}
      {base.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <div className="text-4xl mb-3">{filter === 'pending' ? '✅' : '📋'}</div>
          <p className="text-gray-400 text-sm">
            {filter === 'pending' ? 'All caught up — no pending actions!' : 'No completed actions yet.'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(({ officer, actions: groupActions }) => (
            <div key={officer || 'all'}>
              {officer && (
                <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-2 px-1">
                  {officer}
                </h3>
              )}
              <div className="space-y-2">
                {groupActions.map(action => (
                  <ActionCard
                    key={action.action_id}
                    action={action}
                    expanded={expandedId === action.action_id}
                    onToggle={() => setExpandedId(prev => prev === action.action_id ? null : action.action_id)}
                    onComplete={() => markComplete(action.action_id)}
                    completed={completed.has(action.action_id)}
                    initialStage={donorStageMap[action.donor_sf_id] || ''}
                    donor={donorMap[action.donor_sf_id] || null}
                    currentUser={currentUser}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
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

function ActionCard({ action, expanded, onToggle, onComplete, completed, initialStage, donor, currentUser }) {
  const [confirming, setConfirming] = useState(false)
  const [notes, setNotes] = useState('')
  const [meaningfulConversation, setMeaningfulConversation] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const [stage, setStage] = useState(initialStage)
  const [pendingStage, setPendingStage] = useState(initialStage)
  const [stageNotes, setStageNotes] = useState('')
  const [stageSaving, setStageSaving] = useState(false)
  const [stageError, setStageError] = useState(null)
  const [stageSaved, setStageSaved] = useState(false)

  const stageChanged = pendingStage !== stage

  async function handleSaveStage(e) {
    e.stopPropagation()
    setStageSaving(true)
    setStageError(null)
    try {
      await updateStage(action.donor_account_id || action.donor_sf_id, pendingStage, stageNotes, currentUser?.sf_user_id, action.donor_sf_id)
      setStage(pendingStage)
      setStageNotes('')
      setStageSaved(true)
      setTimeout(() => setStageSaved(false), 3000)
    } catch (err) {
      setStageError(err.message || 'Save failed')
    } finally {
      setStageSaving(false)
    }
  }

  const priorityClass = PRIORITY_COLOR[action.priority] || PRIORITY_COLOR[3]
  const dueDate = action.due_date ? new Date(action.due_date) : null
  const isOverdue = dueDate && dueDate < new Date() && !completed
  const icon = ACTIVITY_ICON[action.activity] || '📋'

  async function handleConfirm() {
    setLoading(true)
    setError(null)
    try {
      await completeAction(action.action_id, notes, meaningfulConversation.join(';'), currentUser?.sf_user_id)
      onComplete()
      setConfirming(false)
      setNotes('')
      setMeaningfulConversation([])
    } catch (e) {
      setError(e.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  function handleCancel() {
    setConfirming(false)
    setNotes('')
    setMeaningfulConversation([])
    setError(null)
  }

  function toggleConversation(opt) {
    setMeaningfulConversation(prev => prev.includes(opt) ? prev.filter(v => v !== opt) : [...prev, opt])
  }

  return (
    <div className={`bg-white rounded-xl border transition-all ${
      isOverdue ? 'border-red-200' : confirming ? 'border-emerald-200' : 'border-gray-200'
    } ${completed ? 'opacity-50' : ''}`}>
      <div className="p-4 flex items-start gap-4">
        {/* Icon */}
        <div className="text-2xl mt-0.5 shrink-0">{icon}</div>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2 flex-wrap">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${priorityClass}`}>
              {PRIORITY_LABEL[action.priority]}
            </span>
            <span className="text-sm font-semibold text-gray-800">{action.label}</span>
          </div>
          <div className="mt-1 flex items-center gap-3 flex-wrap">
            <span className="text-sm text-gray-700 font-medium">{action.donor_name}</span>
            {(action.donor_entity_type === 'organization') && (
              <span className="inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700 border border-blue-200">ORG</span>
            )}
            {(action.donor_entity_type === 'affiliated_individual') && (
              <span className="inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-700 border border-purple-200" title={action.donor_primary_affiliation || ''}>
                {action.donor_primary_affiliation || 'AFFILIATED'}
              </span>
            )}
            {action.donor_tier && (
              <span className="text-xs text-gray-400 capitalize">{action.donor_tier.replace('_', '-')}</span>
            )}
            {action.donor_ai_score !== null && action.donor_ai_score !== undefined && (
              <span className="text-xs text-gray-400">Score: {action.donor_ai_score}</span>
            )}
            {action.gift_officer && (
              <span className="text-xs text-gray-400">→ {action.gift_officer}</span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1">{action.reason}</p>

          {action.ask_amount && (
            <p className="text-xs font-semibold text-teal mt-1">
              Suggested ask: {formatCurrency(action.ask_amount)}
            </p>
          )}
        </div>

        {/* Right side */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          {dueDate && (
            <span className={`text-xs font-medium ${isOverdue ? 'text-red-600' : 'text-gray-400'}`}>
              {isOverdue ? '⚠ Overdue' : `Due ${formatDate(action.due_date)}`}
            </span>
          )}
          <div className="flex items-center gap-2">
            {!completed && !confirming && (
              <button
                onClick={() => setConfirming(true)}
                className="text-xs text-emerald-600 hover:text-emerald-700 border border-emerald-200 hover:border-emerald-400 px-2.5 py-1 rounded-lg transition-colors"
              >
                Mark done
              </button>
            )}
            {!confirming && (
              <button
                onClick={onToggle}
                className="text-xs text-gray-400 hover:text-gray-600 px-2.5 py-1 rounded-lg border border-gray-200 hover:border-gray-400 transition-colors"
              >
                {expanded ? 'Less' : 'Details'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Inline confirm */}
      {confirming && (
        <div className="px-4 pb-4 pt-3 border-t border-emerald-100 bg-emerald-50/40 rounded-b-xl">
          <p className="text-xs font-semibold text-emerald-700 mb-2">Log this activity as completed?</p>
          <div className="mb-2">
            <label className="block text-xs text-gray-500 mb-1">Held Meaningful Conversation</label>
            <div className="flex flex-wrap gap-1.5">
              {MEANINGFUL_CONVERSATION_OPTIONS.map(opt => (
                <button
                  key={opt}
                  onClick={() => toggleConversation(opt)}
                  disabled={loading}
                  className={`text-[11px] px-2 py-1 rounded-lg font-medium border transition-colors disabled:opacity-50 ${
                    meaningfulConversation.includes(opt)
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-emerald-400'
                  }`}
                >
                  {meaningfulConversation.includes(opt) && '✓ '}{opt}
                </button>
              ))}
            </div>
          </div>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Optional notes (outcome, next steps...)"
            rows={2}
            disabled={loading}
            className="w-full text-xs border border-gray-200 rounded-lg p-2 resize-none focus:outline-none focus:border-emerald-400 disabled:opacity-50 bg-white"
          />
          {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              {loading ? 'Saving...' : 'Confirm & log to Salesforce'}
            </button>
            <button
              onClick={handleCancel}
              disabled={loading}
              className="text-xs border border-gray-200 text-gray-600 hover:border-gray-400 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Expanded detail */}
      {expanded && !confirming && (
        <div className="px-4 pb-4 pt-0 border-t border-gray-100 mt-1">
          {/* AI Narrative */}
          {(action.ai_narrative || donor?.ai_narrative) && (
            <div className="bg-teal/5 rounded-lg p-3 mt-3">
              <p className="text-xs font-semibold text-teal/70 uppercase tracking-wider mb-1">Donor Portrait</p>
              <p className="text-sm text-gray-700 leading-relaxed">{action.ai_narrative || donor.ai_narrative}</p>
            </div>
          )}

          {/* AI Recommendation */}
          {(() => {
            const askAmt = donor?.ask_amount || action.ask_amount
            const askRat = donor?.ask_rationale
            if (!askAmt && !askRat) return null
            return (
              <div className="mt-3 bg-teal/5 rounded-lg p-3 border border-teal/20">
                <p className="text-xs font-semibold text-teal/70 uppercase tracking-wider mb-1">AI Recommendation</p>
                {askAmt > 0 && (
                  <p className="text-sm font-bold text-teal mb-1">
                    Recommended ask: {formatCurrency(askAmt)}
                  </p>
                )}
                {askRat && (
                  <p className="text-sm text-gray-700">{askRat}</p>
                )}
              </div>
            )
          })()}

          {/* Donor Intelligence */}
          {(() => {
            const d = donor
            const aiScore = d?.ai_score ?? action.donor_ai_score
            const tier = d?.donor_tier || action.donor_tier
            const askAmt = d?.ask_amount || action.ask_amount
            const askRat = d?.ask_rationale
            return (
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-white rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Giving Summary</p>
                <div className="space-y-1 text-xs">
                  {d ? (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Total lifetime</span>
                        <span className="font-semibold">{formatCurrency(d.total_giving)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">This FY</span>
                        <span className="font-semibold">{formatCurrency(d.giving_this_fy)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Last FY</span>
                        <span className="font-semibold">{formatCurrency(d.giving_last_fy)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Gift count</span>
                        <span className="font-semibold">{d.gift_count}</span>
                      </div>
                      {d.last_gift_date && (
                        <div className="flex justify-between">
                          <span className="text-gray-500">Last gift</span>
                          <span className="font-semibold">{daysSince(d.last_gift_date)}d ago</span>
                        </div>
                      )}
                      {d.is_recurring && (
                        <div className="flex justify-between text-emerald-600">
                          <span>Recurring ({d.rd_period})</span>
                          <span className="font-semibold">{formatCurrency(d.rd_amount)}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {tier && (
                        <div className="flex justify-between">
                          <span className="text-gray-500">Tier</span>
                          <span className="font-semibold capitalize">{tier.replace('_', '-')}</span>
                        </div>
                      )}
                      <p className="text-gray-400 italic">Full giving data available in Donors tab</p>
                    </>
                  )}
                </div>
              </div>

              <div className="bg-white rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">AI Scores</p>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-500">AI Score</span>
                    <span className={`font-bold ${(aiScore || 0) >= 70 ? 'text-emerald-600' : (aiScore || 0) >= 40 ? 'text-amber-600' : 'text-red-500'}`}>
                      {aiScore != null ? Math.round(aiScore) : '—'}
                    </span>
                  </div>
                  {d && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Lapse Risk</span>
                        <span className={`font-bold ${(d.lapse_risk || 0) >= 0.6 ? 'text-red-500' : (d.lapse_risk || 0) >= 0.3 ? 'text-amber-600' : 'text-emerald-600'}`}>
                          {d.lapse_risk != null ? `${(d.lapse_risk * 100).toFixed(0)}%` : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Upgrade</span>
                        <span className={`font-bold ${(d.upgrade_propensity || 0) >= 0.6 ? 'text-emerald-600' : 'text-gray-600'}`}>
                          {d.upgrade_propensity != null ? `${(d.upgrade_propensity * 100).toFixed(0)}%` : '—'}
                        </span>
                      </div>
                      {(d.rfm_recency || d.rfm_frequency || d.rfm_monetary) && (
                        <div className="flex justify-between">
                          <span className="text-gray-500">RFM</span>
                          <span className="font-mono text-gray-700">
                            R{d.rfm_recency ?? '?'} F{d.rfm_frequency ?? '?'} M{d.rfm_monetary ?? '?'}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              {d ? (
                <div className="bg-white rounded-lg p-3 border border-gray-200">
                  <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Contact</p>
                  <div className="space-y-1 text-xs text-gray-600">
                    {d.email && <p>{d.email}</p>}
                    {d.phone && <p>{d.phone}</p>}
                    {(d.city || d.state) && (
                      <p>{[d.city, d.state].filter(Boolean).join(', ')}</p>
                    )}
                    {d.gift_officer && <p className="text-gray-400">Officer: {d.gift_officer}</p>}
                  </div>
                </div>
              ) : (
                <div className="bg-white rounded-lg p-3 border border-gray-200">
                  <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Officer</p>
                  <div className="space-y-1 text-xs text-gray-600">
                    {action.gift_officer && <p className="font-medium">{action.gift_officer}</p>}
                  </div>
                </div>
              )}

              {(askAmt || d?.current_action_plan) && (
                <div className="bg-white rounded-lg p-3 border border-gray-200">
                  {askAmt && (
                    <>
                      <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Recommended Ask</p>
                      <p className="text-lg font-bold text-teal">{formatCurrency(askAmt)}</p>
                      {askRat && (
                        <p className="text-xs text-gray-500 mt-1">{askRat}</p>
                      )}
                    </>
                  )}
                  {d?.current_action_plan && (
                    <div className={askAmt ? 'mt-2 pt-2 border-t border-gray-100' : ''}>
                      <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Action Plan</p>
                      <p className="text-xs text-gray-600">{d.current_action_plan}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
            )
          })()}

          {/* Pipeline Stage */}
          <div className="mt-3 bg-gray-50 rounded-lg p-3 border border-gray-200">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Pipeline Stage</p>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={pendingStage}
                onChange={e => { setPendingStage(e.target.value); setStageSaved(false) }}
                onClick={e => e.stopPropagation()}
                disabled={stageSaving}
                className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-gray-700 bg-white focus:outline-none focus:border-teal disabled:opacity-50"
              >
                <option value="">— No stage set —</option>
                {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              {donor?.stage_entry_date && (
                <span className="text-xs text-gray-400">
                  Stage since: <span className="text-gray-600">{formatDate(donor.stage_entry_date)}</span>
                </span>
              )}
              {donor?.current_action_plan_date && (
                <span className="text-xs text-gray-400">
                  Action plan: <span className="text-gray-600">{formatDate(donor.current_action_plan_date)}</span>
                </span>
              )}
              {stageChanged && (
                <>
                  <input
                    type="text"
                    placeholder="Notes (optional)"
                    value={stageNotes}
                    onChange={e => setStageNotes(e.target.value)}
                    onClick={e => e.stopPropagation()}
                    disabled={stageSaving}
                    className="flex-1 min-w-24 border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-teal disabled:opacity-50"
                  />
                  <button
                    onClick={handleSaveStage}
                    disabled={stageSaving}
                    className="text-xs bg-teal text-white px-2.5 py-1 rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
                  >
                    {stageSaving ? 'Saving...' : 'Save to SF'}
                  </button>
                </>
              )}
              {stageSaved && !stageChanged && (
                <span className="text-xs text-emerald-600 font-medium">✓ Saved</span>
              )}
            </div>
            {stageError && <p className="text-xs text-red-600 mt-1">{stageError}</p>}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-gray-500">
            <span>Action ID: <span className="font-mono text-gray-700">{action.action_id}</span></span>
            <span>Donor SF ID: <span className="font-mono text-gray-700">{action.donor_sf_id}</span></span>
            <span>Activity: <span className="text-gray-700">{action.activity}</span></span>
            <span>Created: <span className="text-gray-700">{formatDate(action.created_at)}</span></span>
          </div>
        </div>
      )}
    </div>
  )
}
