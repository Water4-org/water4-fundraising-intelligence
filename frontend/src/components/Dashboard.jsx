import { useState } from 'react'
import ActionsPanel        from './ActionsPanel.jsx'
import DonorIntel          from './DonorIntel.jsx'
import CampaignIndex       from './CampaignIndex.jsx'
import PortfolioView       from './PortfolioView.jsx'
import IntelligenceGuide   from './IntelligenceGuide.jsx'
import ExecutiveDashboard  from './ExecutiveDashboard.jsx'
import PipelineDashboard   from './PipelineDashboard.jsx'
import OfficersView        from './OfficersView.jsx'

export default function Dashboard({ donors, campaigns, actions, lastRefresh, onRefresh, currentUser }) {
  const [activeTab, setActiveTab] = useState('actions')

  // Default officer filter to the logged-in user (matched by Salesforce User ID)
  const myOfficerName = currentUser?.sf_user_id
    ? donors.find(d => d.gift_officer_id === currentUser.sf_user_id)?.gift_officer || 'all'
    : 'all'

  const isAdmin = currentUser?.is_admin === true

  // Non-admins are locked to their own officer view
  const [selectedOfficer, setSelectedOfficer] = useState(
    isAdmin ? myOfficerName : (myOfficerName !== 'all' ? myOfficerName : 'all')
  )

  const urgentCount = actions.filter(a => a.priority <= 2 && a.status === 'pending').length
  const pendingCount = actions.filter(a => a.status === 'pending').length

  const officers = [...new Set(donors.map(d => d.gift_officer).filter(Boolean))].sort()

  const ALL_TABS = [
    { id: 'guide',     label: 'How It Works' },
    { id: 'executive', label: 'Executive Dashboard', adminOnly: true },
    { id: 'actions',   label: 'Action Queue',    badge: urgentCount || null, badgeColor: 'bg-red-500' },
    { id: 'donors',    label: `Donors (${donors.length})` },
    { id: 'pipeline',  label: 'Pipeline' },
    { id: 'campaigns', label: `Campaigns (${campaigns.length})` },
    { id: 'portfolio', label: 'Portfolio View', adminOnly: true },
    { id: 'officers',  label: 'Officers', adminOnly: true },
  ]

  const TABS = ALL_TABS.filter(t => !t.adminOnly || isAdmin)

  // Non-admins are always locked to their own officer
  const effectiveOfficer = isAdmin ? selectedOfficer : (myOfficerName !== 'all' ? myOfficerName : selectedOfficer)

  const filteredActions = effectiveOfficer === 'all'
    ? actions
    : actions.filter(a => a.gift_officer === effectiveOfficer)

  const filteredDonors = effectiveOfficer === 'all'
    ? donors
    : donors.filter(d => d.gift_officer === effectiveOfficer)

  return (
    <div className="min-h-screen bg-cream flex flex-col">

      {/* Nav */}
      <nav className="bg-teal h-14 flex items-center px-6 shadow sticky top-0 z-30">
        <span className="font-serif text-gold text-lg">Water4.org</span>
        <span className="text-white/40 text-xs ml-3 pl-3 border-l border-white/20 uppercase tracking-widest">
          Fundraising Intelligence
        </span>
        <div className="ml-auto flex items-center gap-4">
          {lastRefresh && (
            <span className="text-white/40 text-xs">
              Updated {lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={onRefresh}
            className="text-white/60 hover:text-white text-xs border border-white/20 hover:border-white/40 px-3 py-1 rounded-lg transition-colors"
          >
            Refresh
          </button>
          {currentUser && (
            <div className="flex items-center gap-2 pl-3 border-l border-white/20">
              {currentUser.picture && (
                <img src={currentUser.picture} alt="" className="w-6 h-6 rounded-full" />
              )}
              <span className="text-white/60 text-xs">{currentUser.name}</span>
              <a
                href="/auth/logout"
                className="text-white/40 hover:text-white text-xs transition-colors"
              >
                Sign out
              </a>
            </div>
          )}
        </div>
      </nav>

      {/* Tabs + Officer Filter */}
      <div className="bg-white border-b border-gray-200 px-6 sticky top-14 z-20">
        <div className="flex items-center gap-4 max-w-7xl mx-auto">
          <div className="flex gap-1 flex-1">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`relative text-sm font-medium py-3 px-4 border-b-2 transition-colors
                  ${activeTab === tab.id
                    ? 'border-teal text-teal'
                    : 'border-transparent text-gray-400 hover:text-gray-700'}`}
              >
                {tab.label}
                {tab.badge ? (
                  <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full font-semibold text-white
                    ${tab.badgeColor || 'bg-teal'}`}>
                    {tab.badge}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {officers.length > 1 && activeTab !== 'guide' && isAdmin && (
            <div className="flex items-center gap-2 py-2">
              <span className="text-xs text-gray-400">Officer:</span>
              <select
                value={selectedOfficer}
                onChange={e => setSelectedOfficer(e.target.value)}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1 text-gray-700 bg-white focus:outline-none focus:border-teal"
              >
                <option value="all">All Officers</option>
                {officers.map(o => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </div>
          )}
          {!isAdmin && myOfficerName !== 'all' && activeTab !== 'guide' && (
            <div className="flex items-center gap-2 py-2">
              <span className="text-xs text-gray-400">Viewing:</span>
              <span className="text-xs text-gray-700 font-medium">{myOfficerName}</span>
            </div>
          )}
        </div>
      </div>

      <main className="flex-1 px-6 py-6 max-w-7xl mx-auto w-full">

        {activeTab === 'guide' && (
          <IntelligenceGuide />
        )}

        {activeTab === 'executive' && (
          <ExecutiveDashboard donors={filteredDonors} campaigns={campaigns} actions={filteredActions} />
        )}

        {activeTab === 'actions' && (
          <ActionsPanel actions={filteredActions} donors={donors} currentUser={currentUser} />
        )}

        {activeTab === 'donors' && (
          <DonorIntel donors={filteredDonors} currentUser={currentUser} />
        )}

        {activeTab === 'pipeline' && (
          <PipelineDashboard donors={filteredDonors} campaigns={campaigns} actions={filteredActions} />
        )}

        {activeTab === 'campaigns' && (
          <CampaignIndex campaigns={campaigns} donors={donors} />
        )}

        {activeTab === 'portfolio' && (
          <PortfolioView donors={filteredDonors} campaigns={campaigns} actions={filteredActions} />
        )}

        {activeTab === 'officers' && (
          <OfficersView donors={donors} campaigns={campaigns} actions={actions} />
        )}

      </main>
    </div>
  )
}
