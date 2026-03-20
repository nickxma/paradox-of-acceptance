import React from 'react';

export default function MembersArea({ walletAddress }) {
  return (
    <>
      <div className="pass-hero">
        <div className="member-badge">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Member
        </div>
        <h1 className="pass-headline">The Inner Work</h1>
        <p className="pass-subtitle">
          Members-only material. Practices, notes, and drafts that haven't
          been published on the public site.
        </p>
      </div>

      <div className="members-section">
        <div className="members-label">For Members</div>
        <div className="members-content">

          <h3>On sitting with what you'd rather not</h3>
          <p>
            Most meditation instructions tell you to observe without judgment.
            That's the easy version. The harder version: observe while the judgment
            is already happening, and notice what it's protecting you from.
          </p>
          <p>
            The paradox shows up here. You can't force acceptance — but you can
            stop pretending you've already arrived at it. The space between
            "I should accept this" and "I actually do" is where the real practice lives.
          </p>

          <h3>Three questions for the cushion</h3>
          <p>
            These aren't koans. They're practical questions you can bring into any
            sitting practice. They don't have answers — they have effects.
          </p>
          <blockquote>
            What am I trying to fix right now?
          </blockquote>
          <blockquote>
            What would happen if nothing needed to change?
          </blockquote>
          <blockquote>
            Where in my body does "trying" live?
          </blockquote>
          <p>
            Sit with one for a week. Don't analyze it. Let it dissolve on its own schedule.
          </p>

          <h3>Notes on the observer problem</h3>
          <p>
            Every contemplative tradition eventually runs into the same structural
            problem: who's watching? If you can observe your thoughts, who's observing
            the observer? And if you find that observer — who noticed?
          </p>
          <p>
            This isn't philosophy. It's what happens in practice when you pay attention
            carefully enough. The infinite regress isn't a bug. It's the practice
            deconstructing its own scaffolding.
          </p>
          <p>
            The best teachers don't answer this question. They point you toward the
            experience of the question dissolving.
          </p>

        </div>
      </div>

      <div className="mint-stats">
        Connected as {walletAddress?.slice(0, 6)}...{walletAddress?.slice(-4)}
      </div>
    </>
  );
}
