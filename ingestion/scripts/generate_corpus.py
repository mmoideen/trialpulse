#!/usr/bin/env python3
"""Generate the synthetic TrialPulse document corpus (`data/synthetic/*.md`).

Reads the frozen `data/synthetic/corpus-manifest.json` contract and writes
one markdown file per document, per the manifest's `filename`. Every fact
string listed in a section's `facts[]` is embedded verbatim in that
section's generated prose -- this script asserts that itself before writing
anything, so a typo here fails loudly at generation time rather than
silently at eval time.

Usage:
    python scripts/generate_corpus.py [--check]

`--check` verifies the currently-committed corpus files against the
manifest without rewriting them (used in CI to catch drift between the
manifest and the committed fixtures).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = REPO_ROOT / "data" / "synthetic" / "corpus-manifest.json"
CORPUS_DIR = REPO_ROOT / "data" / "synthetic"

BANNER = (
    "> **SYNTHETIC DATA NOTICE.** Every document in this corpus is entirely "
    "fabricated for TrialPulse local development, automated testing, and "
    "evaluation. It contains no real patient data and no confidential Meridian "
    "Therapeutics information. Any resemblance to real trial participants, "
    "sites, or regulatory correspondence is coincidental."
)

# --------------------------------------------------------------------------
# Section prose, keyed by (document_id, heading). Every fact string listed
# for that section in corpus-manifest.json MUST appear verbatim somewhere in
# this text -- `_check_facts_present` enforces this before any file is
# written.
# --------------------------------------------------------------------------
PROSE: dict[tuple[str, str], str] = {
    # ---- sp-prot-0001: AXIOM-HN01 Protocol v3.0 -------------------------
    ("sp-prot-0001", "1. Study Design"): (
        "AXIOM-HN01 is a randomized, double-blind, placebo-controlled Phase 3 study. "
        "The study evaluates revarafusp alfa in combination with torilizumab against "
        "torilizumab alone in participants with recurrent or metastatic head and neck "
        "squamous cell carcinoma (R/M HNSCC) who have not received prior systemic therapy "
        "in the recurrent or metastatic setting. Planned enrollment is 480 participants "
        "across 92 sites. These sites span North America, Europe, and the Asia-Pacific "
        "region, reflecting the site capability required to support central randomization, "
        "cold-chain drug handling, and blinded safety reporting at scale. Participants are "
        "randomized 1:1 to revarafusp alfa plus torilizumab or placebo plus torilizumab. "
        "Randomization is stratified by PD-L1 combined positive score (CPS) category, human "
        "papillomavirus (HPV) status of the oropharynx, and Eastern Cooperative Oncology "
        "Group (ECOG) performance status at baseline, and is performed centrally through an "
        "interactive response technology (IRT) system to preserve allocation concealment. "
        "Study drug is dispensed by an unblinded pharmacist at each site who has no other "
        "study responsibilities, and all other study personnel, including the investigator "
        "and clinical staff assessing efficacy or safety, remain unaware of treatment "
        "assignment until database lock for the primary analysis."
    ),
    ("sp-prot-0001", "2. Primary Endpoint"): (
        "The primary endpoint is overall survival (OS) in the PD-L1 CPS greater than or "
        "equal to 1 population. This population represents the majority of participants "
        "enrolled in AXIOM-HN01 and is consistent with the population studied in prior "
        "torilizumab registrational trials in R/M HNSCC. Key secondary endpoints include "
        "overall survival in the intent-to-treat population, progression-free survival by "
        "blinded independent central review, objective response rate, duration of response, "
        "and patient-reported outcomes measured using the EORTC QLQ-C30 and QLQ-H&N35 "
        "instruments. The study is powered at 90% to detect a hazard ratio of 0.70. This "
        "assumes a two-sided alpha of 0.05 for the primary comparison and accounts for the "
        "one planned interim analysis described in Section 5. The sample size calculation "
        "assumes a median overall survival of approximately 12 months in the control arm, "
        "consistent with published outcomes for torilizumab monotherapy in this "
        "population, and an enrollment period of approximately 24 months followed by a "
        "minimum follow-up period sufficient to accrue the target number of OS events."
    ),
    ("sp-prot-0001", "3. Key Inclusion Criteria"): (
        "Enrollment in AXIOM-HN01 requires that participants meet all protocol-specified "
        "inclusion criteria prior to randomization. Participants must be at least 18 years "
        "of age. Participants (or their legally authorized representative) must also "
        "provide written informed consent prior to any study-specific procedures, including "
        "screening for PD-L1 and HPV status. Participants must have histologically or "
        "cytologically confirmed squamous cell carcinoma of the oropharynx, oral cavity, "
        "hypopharynx, or larynx that is recurrent or metastatic and not amenable to "
        "curative-intent local therapy. ECOG performance status must be 0 or 1. This "
        "reflects a functional status sufficient to tolerate combination immunotherapy and "
        "protocol-mandated study visits, including biweekly infusions. Participants must "
        "have measurable disease per RECIST v1.1. Assessment is made by the investigator, "
        "with at least one target lesion that has not been previously irradiated unless "
        "there is documented progression at that site. Adequate hematologic, hepatic, and "
        "renal function are also required, along with archival or fresh tumor tissue "
        "sufficient for central PD-L1 and HPV testing prior to randomization."
    ),
    ("sp-prot-0001", "4. Dose and Administration"): (
        "Study treatment is administered in 21-day cycles until documented disease "
        "progression, unacceptable toxicity, withdrawal of consent, or completion of the "
        "maximum permitted duration of therapy. Revarafusp alfa is administered at 1500 mg "
        "intravenously every 3 weeks. It is given as a fixed-dose infusion over "
        "approximately 60 minutes, with the infusion duration extendable per site standard "
        "operating procedure if an infusion-related reaction occurs. Torilizumab is "
        "administered at 200 mg intravenously every 3 weeks. It is infused immediately "
        "following completion of the revarafusp alfa infusion and any associated "
        "observation period. Premedication with an antihistamine is recommended prior to "
        "the first two cycles, given the known association between revarafusp alfa and "
        "infusion-related reactions described in the Investigator Brochure. Dose "
        "modifications for revarafusp alfa follow the toxicity management guidance in the "
        "current Investigator Brochure edition in effect at each site; torilizumab dose "
        "modifications follow the current approved product label. No intra-participant dose "
        "escalation is permitted, and dose re-escalation after a dose reduction is not "
        "permitted under this protocol version."
    ),
    ("sp-prot-0001", "5. Interim Analysis"): (
        "The statistical analysis plan for AXIOM-HN01 pre-specifies one formal interim "
        "analysis of overall survival prior to the final analysis. A single interim "
        "analysis is planned after 60% of target OS events. This threshold is expected to "
        "be reached in the PD-L1 CPS greater than or equal to 1 population, at which point "
        "the O'Brien-Fleming alpha-spending boundary permits early stopping for "
        "overwhelming efficacy. The interim analysis is reviewed by an independent Data "
        "Monitoring Committee. The Committee is composed of oncologists, a biostatistician, "
        "and a patient advocate, none of whom are otherwise involved in the conduct of the "
        "study. It also conducts unblinded safety reviews on a quarterly cadence "
        "independent of the efficacy interim analysis, with authority to recommend study "
        "modification, temporary suspension of enrollment, or early termination if the "
        "safety profile is unfavorable. Recommendations from the Committee are transmitted "
        "to the sponsor's unblinded statistician and are not shared with the blinded study "
        "team unless a protocol amendment is required as a result."
    ),
    # ---- sp-prot-0002: AXIOM-HN01 Protocol v4.0 -------------------------
    ("sp-prot-0002", "1. Study Design"): (
        "AXIOM-HN01 is a randomized, double-blind, placebo-controlled Phase 3 study. "
        "This protocol amendment (version 4.0) updates the study design based on emerging "
        "enrollment and safety experience while preserving the fundamental double-blind, "
        "placebo-controlled structure established in version 3.0. Planned enrollment is "
        "increased to 528 participants across 104 sites. The additional participants and "
        "sites were added to preserve statistical power for overall survival following a "
        "blinded review of the assumed control-arm event rate. Participants are randomized "
        "1:1 to revarafusp alfa plus torilizumab or placebo plus torilizumab. "
        "Randomization continues to be stratified by PD-L1 combined positive score (CPS) "
        "category, HPV status of the oropharynx, and ECOG performance status at baseline, "
        "and remains centrally managed through the interactive response technology (IRT) "
        "system. All sites active under version 3.0 continue participation under version "
        "4.0 following local IRB or ethics committee approval, and newly activated sites "
        "are initiated directly under version 4.0."
    ),
    ("sp-prot-0002", "2. Primary Endpoint"): (
        "The primary endpoint is overall survival (OS) in the PD-L1 CPS greater than or "
        "equal to 1 population. This endpoint is unchanged from protocol version 3.0. "
        "Progression-free survival was elevated from an exploratory endpoint to a key "
        "secondary endpoint in version 4.0. This change reflects feedback from the FDA "
        "Division of Oncology 2 during the End of Phase 2 meeting, which recommended "
        "progression-free survival be collected with the same rigor as the primary "
        "endpoint, given its relevance to regulatory decision-making in this indication. "
        "The study is powered at 90% to detect a hazard ratio of 0.70. The increased "
        "enrollment described in Section 1 preserves this power under the revised "
        "control-arm event-rate assumptions incorporated into version 4.0. No change was "
        "made to the alpha-spending approach or to the definition of the PD-L1 CPS greater "
        "than or equal to 1 analysis population."
    ),
    ("sp-prot-0002", "3. Key Inclusion Criteria"): (
        "The inclusion criteria for AXIOM-HN01 version 4.0 largely carry forward from "
        "version 3.0, with one substantive addition described below. Participants must be "
        "at least 18 years of age. Participants must have histologically or cytologically "
        "confirmed squamous cell carcinoma of the oropharynx, oral cavity, hypopharynx, or "
        "larynx that is recurrent or metastatic. ECOG performance status must be 0 or 1. "
        "This is assessed at the time of screening, consistent with protocol version 3.0. "
        "Participants must have measurable disease per RECIST v1.1. Version 4.0 permits "
        "enrollment of participants with treated, stable brain metastases. Eligibility "
        "requires that treatment was completed at least four weeks prior to randomization, "
        "that the participant is neurologically stable without a corticosteroid requirement "
        "beyond a physiologic replacement dose, and that follow-up brain imaging confirms "
        "no evidence of progression. This addition reflects emerging real-world experience "
        "suggesting that clinically stable, treated brain metastases did not meaningfully "
        "affect systemic treatment tolerability in torilizumab-based combinations, and "
        "that their prior exclusion was disproportionately limiting enrollment given how "
        "frequently brain metastases occur in this population."
    ),
    ("sp-prot-0002", "4. Dose and Administration"): (
        "Dosing procedures for AXIOM-HN01 version 4.0 are unchanged except for the new "
        "observation requirement described below. Revarafusp alfa is administered at 1500 "
        "mg intravenously every 3 weeks. Torilizumab is administered at 200 mg "
        "intravenously every 3 weeks. Version 4.0 adds a mandatory 60-minute observation "
        "period after the first infusion. This requirement was added following review of "
        "infusion-related reaction reports summarized in the Development Safety Update "
        "Report, which showed that the majority of Grade 3 or higher infusion-related "
        "reactions occurred within the first hour after the initial dose. Sites must have "
        "emergency equipment and trained personnel available throughout the observation "
        "period. Subsequent infusions may follow the standard post-infusion monitoring "
        "procedure described in the Investigator Brochure unless a participant experienced "
        "an infusion-related reaction at a prior cycle, in which case the extended "
        "observation period is repeated at the next scheduled infusion."
    ),
    ("sp-prot-0002", "5. Interim Analysis"): (
        "The statistical analysis plan was updated in protocol version 4.0 to add an "
        "earlier look at the data. Version 4.0 adds a second interim analysis after 40% of "
        "target OS events. This earlier interim analysis uses a more conservative "
        "O'Brien-Fleming boundary than the analysis planned after 60% of events, reflecting "
        "the smaller information fraction available at that time. The interim analysis is "
        "reviewed by an independent Data Monitoring Committee. The Committee's charter, "
        "membership, and unblinding procedures are unchanged from version 3.0; only the "
        "number and timing of scheduled efficacy looks has changed. As with the original "
        "interim analysis, the Committee retains authority to recommend early stopping for "
        "efficacy, futility, or safety at either scheduled look, and its recommendations "
        "are communicated to the sponsor's unblinded statistician rather than to the "
        "blinded study team."
    ),
    ("sp-prot-0002", "6. Summary of Changes from Version 3.0"): (
        "This section summarizes the substantive changes incorporated into protocol "
        "version 4.0 relative to version 3.0, consistent with the summary of changes "
        "submitted to the FDA under IND Amendment 12. Enrollment increased from 480 to 528 "
        "participants. Site count increased from 92 to 104. These two changes were made "
        "together to preserve statistical power for the overall survival primary endpoint "
        "following a blinded reassessment of the assumed control-arm event rate. Brain "
        "metastases exclusion criterion was relaxed. Participants with treated, stable "
        "brain metastases meeting the criteria in Section 3 may now enroll. A second "
        "interim analysis was added. It occurs at 40% of target OS events, in addition to "
        "the previously planned analysis at 60% of events. A 60-minute post-infusion "
        "observation period was added. It follows the first dose of study treatment, based "
        "on the timing pattern of infusion-related reactions observed to date. Site "
        "personnel should review the full protocol text for the complete rationale "
        "supporting each change; this section is intended as a navigational summary only."
    ),
    # ---- sp-prot-0003: AXIOM-HN02 Protocol v1.0 -------------------------
    ("sp-prot-0003", "1. Study Design"): (
        "AXIOM-HN02 is an open-label Phase 2 study in first-line locally advanced "
        "HNSCC. The study is designed to evaluate revarafusp alfa in combination with "
        "concurrent chemoradiotherapy in participants who have not previously received "
        "systemic or radiation therapy for their disease. Planned enrollment is 120 "
        "participants across 28 sites. Sites are located in the United States and Western "
        "Europe and were selected based on experience delivering concurrent "
        "chemoradiotherapy protocols and managing the dermatologic toxicities associated "
        "with EGFR-targeted agents. Unlike AXIOM-HN01, AXIOM-HN02 does not include a "
        "placebo control; all participants receive revarafusp alfa alongside "
        "standard-of-care chemoradiotherapy, and the study is designed to characterize the "
        "safety and preliminary efficacy of this combination ahead of a possible "
        "randomized Phase 3 study in the locally advanced setting. Enrollment is expected "
        "to complete within approximately 18 months of the first site activation."
    ),
    ("sp-prot-0003", "2. Primary Endpoint"): (
        "The primary endpoint of AXIOM-HN02 is objective response rate per RECIST v1.1. "
        "Response is assessed by the investigator at the completion of concurrent "
        "chemoradiotherapy. Objective response rate was selected as the primary endpoint "
        "for this Phase 2 study because it is measurable within months of treatment "
        "completion, allowing an efficient early read on the activity of the combination "
        "before committing to a larger and longer Phase 3 program. Secondary endpoints "
        "include duration of response, progression-free survival, locoregional control "
        "rate, and the incidence and severity of treatment-related adverse events, "
        "particularly dermatologic and mucosal toxicities that may be additive between "
        "revarafusp alfa and radiotherapy. An exploratory endpoint evaluates circulating "
        "tumor DNA clearance as an early biomarker of response, which may inform patient "
        "selection strategies for a subsequent randomized study."
    ),
    ("sp-prot-0003", "3. Dose and Administration"): (
        "Dosing of revarafusp alfa in AXIOM-HN02 differs from the AXIOM-HN01 regimen "
        "to align with the concurrent chemoradiotherapy schedule. Revarafusp alfa is "
        "administered at 1500 mg intravenously every 2 weeks in AXIOM-HN02. Dosing "
        "continues at this schedule for the duration of concurrent chemoradiotherapy, "
        "followed by continuation at the same dose and schedule during a consolidation "
        "phase of up to six additional cycles in participants without disease progression. "
        "The every-2-week schedule was selected to maintain adequate drug exposure across "
        "the compressed radiotherapy treatment window, which is typically six to seven "
        "weeks in duration. Standard premedication and infusion monitoring procedures from "
        "the Investigator Brochure apply. Radiation therapy is delivered per institutional "
        "standard using either intensity-modulated radiation therapy or volumetric "
        "modulated arc therapy, with concurrent cisplatin-based chemotherapy administered "
        "per investigator discretion consistent with local standard of care."
    ),
    # ---- sp-ib-0001: Investigator Brochure Edition 5 ----------------------
    ("sp-ib-0001", "2. Mechanism of Action"): (
        "Revarafusp alfa is a bifunctional antibody targeting EGFR and TGF-beta. It is "
        "designed to simultaneously block a well-established oncogenic driver pathway in "
        "head and neck squamous cell carcinoma and to neutralize a key mediator of "
        "tumor-associated immune suppression. The EGFR arm is a high-affinity IgG1 and the "
        "TGF-beta arm is a ligand trap. The ligand trap binds and sequesters all three "
        "TGF-beta isoforms (TGF-beta1, TGF-beta2, and TGF-beta3) in the tumor "
        "microenvironment, preventing them from engaging TGF-beta receptors on infiltrating "
        "immune cells. By combining EGFR blockade with local TGF-beta neutralization in a "
        "single molecule, revarafusp alfa is designed to reduce systemic TGF-beta-related "
        "toxicity relative to a systemic small-molecule TGF-beta receptor inhibitor, while "
        "concentrating TGF-beta trapping activity at sites of EGFR overexpression, which is "
        "common in HNSCC tumor tissue. Preclinical models suggest that this dual mechanism "
        "enhances anti-tumor T-cell infiltration and activity when combined with checkpoint "
        "inhibitors such as torilizumab, providing the scientific rationale for the "
        "AXIOM-HN01 and AXIOM-HN02 combination studies."
    ),
    ("sp-ib-0001", "5. Reference Safety Information"): (
        "This section presents the reference safety information for revarafusp alfa as of "
        "Edition 5, reflecting cumulative safety data from the completed Phase 1 "
        "dose-escalation study and ongoing Phase 1b expansion cohorts. The expected adverse "
        "reactions include acneiform dermatitis, infusion-related reactions, and "
        "hypomagnesemia. These are consistent with the known class effects of "
        "EGFR-targeted therapy combined with the infusion characteristics typical of a "
        "bifunctional biologic. Edition 5 lists Grade 3 or higher acneiform dermatitis at "
        "an incidence of 11 percent. This reflects the pooled Phase 1 safety population, "
        "with onset typically occurring within the first two treatment cycles and generally "
        "manageable with topical and oral antibiotic therapy, dose interruption, or dose "
        "reduction per the toxicity management algorithm in Appendix C. Infusion-related "
        "reactions occurred predominantly with the first or second infusion and were "
        "manageable with premedication and, where needed, temporary interruption of the "
        "infusion. Hypomagnesemia was generally low-grade and responsive to oral or "
        "intravenous magnesium supplementation without requiring treatment discontinuation."
    ),
    # ---- sp-ib-0002: Investigator Brochure Edition 6 ----------------------
    ("sp-ib-0002", "2. Mechanism of Action"): (
        "Revarafusp alfa is a bifunctional antibody targeting EGFR and TGF-beta. It is "
        "designed to simultaneously block a well-established oncogenic driver pathway in "
        "head and neck squamous cell carcinoma and to neutralize a key mediator of "
        "tumor-associated immune suppression. The EGFR arm is a high-affinity IgG1 and the "
        "TGF-beta arm is a ligand trap. The ligand trap binds and sequesters all three "
        "TGF-beta isoforms (TGF-beta1, TGF-beta2, and TGF-beta3) in the tumor "
        "microenvironment, preventing them from engaging TGF-beta receptors on infiltrating "
        "immune cells. By combining EGFR blockade with local TGF-beta neutralization in a "
        "single molecule, revarafusp alfa is designed to reduce systemic TGF-beta-related "
        "toxicity relative to a systemic small-molecule TGF-beta receptor inhibitor, while "
        "concentrating TGF-beta trapping activity at sites of EGFR overexpression, which is "
        "common in HNSCC tumor tissue. Preclinical models suggest that this dual mechanism "
        "enhances anti-tumor T-cell infiltration and activity when combined with checkpoint "
        "inhibitors such as torilizumab, providing the scientific rationale for the "
        "AXIOM-HN01 and AXIOM-HN02 combination studies."
    ),
    ("sp-ib-0002", "5. Reference Safety Information"): (
        "This section presents the reference safety information for revarafusp alfa as of "
        "Edition 6, updated following additional exposure accrued across AXIOM-HN01 and "
        "AXIOM-HN02 and summarized in the 2026 Development Safety Update Report. Edition "
        "6 adds Grade 3 or higher hypertension as an identified risk. This follows signal "
        "evaluation that identified a numerically higher rate of hypertension in "
        "revarafusp alfa-treated participants relative to background rates in this "
        "population, consistent with on-target TGF-beta pathway inhibition, which is "
        "mechanistically linked to blood pressure regulation. Edition 6 revises Grade 3 or "
        "higher acneiform dermatitis incidence to 13 percent. This reflects the larger, "
        "more mature safety database now available compared with Edition 5. "
        "Infusion-related reactions remain an identified risk requiring premedication. "
        "Extended post-infusion observation, described in the current protocol, further "
        "mitigates this risk. Hypomagnesemia remains an expected adverse reaction and "
        "continues to be manageable with supplementation. Investigators should review "
        "Section 7 for updated dose modification guidance corresponding to these safety "
        "updates."
    ),
    ("sp-ib-0002", "7. Guidance for the Investigator"): (
        "This section provides practical dose modification and monitoring guidance for "
        "investigators managing participants receiving revarafusp alfa. Investigators must "
        "hold dosing for Grade 3 acneiform dermatitis until recovery to Grade 1 or lower. "
        "Dosing may then resume at the same or a reduced dose per the toxicity management "
        "table in Appendix C; a second occurrence of Grade 3 acneiform dermatitis after "
        "dose reduction should prompt discontinuation of revarafusp alfa. Magnesium levels "
        "should be monitored every cycle. Monitoring should occur prior to dosing, given "
        "the identified risk of hypomagnesemia, with supplementation initiated per "
        "institutional practice for any participant with a serum magnesium level below the "
        "lower limit of normal. Blood pressure should be assessed at every visit given the "
        "newly identified hypertension risk described in Section 5, with dose interruption "
        "considered for Grade 3 hypertension that does not respond to standard "
        "antihypertensive management within one week."
    ),
    # ---- sp-reg-0001: IND 145678 Annual Report 2026 -----------------------
    ("sp-reg-0001", "1. Summary of Clinical Progress"): (
        "This annual report is submitted pursuant to 21 CFR 312.33 to summarize the "
        "clinical progress of the revarafusp alfa development program under IND 145678 "
        "during the reporting period. As of 31 March 2026, impacted studies under IND "
        "145678 have enrolled 412 participants cumulatively. This reflects continued site "
        "activation and enrollment momentum since the prior annual report. Two studies "
        "were active during the reporting period: AXIOM-HN01 and AXIOM-HN02. "
        "AXIOM-HN01 continued enrollment under protocol version 3.0 for the majority of "
        "the reporting period, transitioning to version 4.0 following FDA acknowledgment "
        "of Amendment 12 in July 2026. AXIOM-HN02 activated its first sites during the "
        "reporting period and began enrolling participants in the first-line locally "
        "advanced setting. No new studies were initiated under this IND during the "
        "reporting period, and no studies were terminated or placed on clinical hold."
    ),
    ("sp-reg-0001", "3. Changes in the Investigator Brochure"): (
        "The Investigator Brochure was updated once during the reporting period to "
        "incorporate additional safety experience accrued across the program. Investigator "
        "Brochure Edition 6 was distributed to all active sites in May 2026. This followed "
        "sponsor approval of the updated reference safety information, including the "
        "addition of hypertension as an identified risk and the revised incidence estimate "
        "for Grade 3 or higher acneiform dermatitis. Sites were required to acknowledge "
        "receipt of Edition 6 and to update site-specific informed consent documents where "
        "the revised reference safety information affected the description of expected "
        "risks. No sites reported delays in Edition 6 distribution or acknowledgment "
        "beyond the standard 30-day implementation window specified in the sponsor's "
        "document control procedure."
    ),
    # ---- sp-reg-0002: IND Amendment 12 -------------------------------------
    ("sp-reg-0002", "1. Purpose of Amendment"): (
        "This IND amendment is submitted pursuant to 21 CFR 312.30 to notify the FDA of "
        "changes to the AXIOM-HN01 protocol. Amendment 12 submits AXIOM-HN01 Protocol "
        "version 4.0 to the FDA. The submission includes the associated summary of "
        "changes, an updated informed consent form template, and Investigator Brochure "
        "Edition 6, which contains the reference safety information supporting the "
        "protocol changes. Amendment 12 was submitted on 09 June 2026 and the 30-day "
        "review period ended on 09 July 2026. The review period elapsed without a clinical "
        "hold or request for additional information from the Division, permitting sites to "
        "implement protocol version 4.0 following local IRB or ethics committee approval. "
        "The sponsor notified all active sites of FDA acknowledgment immediately following "
        "expiration of the 30-day review period."
    ),
    ("sp-reg-0002", "2. Pending Amendments"): (
        "Two additional amendments to this IND are in preparation and are summarized here "
        "for the Division's awareness ahead of formal submission. Amendment 13 covering "
        "the updated statistical analysis plan is pending and targeted for submission in "
        "September 2026. This amendment will formalize the two-interim-analysis design "
        "described in Protocol version 4.0, Section 5, including the revised "
        "alpha-spending boundaries for both the 40% and 60% information fraction looks. "
        "Amendment 14 covering the AXIOM-HN02 dose expansion cohort is pending internal "
        "review. This amendment, once finalized, will add a dose expansion cohort to "
        "AXIOM-HN02 to further characterize the safety and preliminary efficacy of "
        "revarafusp alfa in combination with chemoradiotherapy prior to a potential "
        "randomized Phase 3 study in the locally advanced setting. Neither amendment is "
        "expected to require a change to the currently enrolling protocol versions."
    ),
    # ---- sp-reg-0003: Pre-NDA Meeting Request Package ----------------------
    ("sp-reg-0003", "1. Meeting Request"): (
        "This package is submitted to request a milestone meeting in advance of a planned "
        "New Drug Application submission for revarafusp alfa in combination with "
        "torilizumab. Meridian requests a Type B pre-NDA meeting with the FDA Division of "
        "Oncology 2. The meeting will discuss the adequacy of the planned NDA content, "
        "including the clinical, nonclinical, and chemistry, manufacturing, and controls "
        "sections, ahead of a planned submission following the AXIOM-HN01 primary "
        "analysis. The pre-NDA meeting is scheduled for 12 November 2026. This date "
        "follows the Division's confirmation of meeting date availability within the "
        "standard 75-day scheduling window for Type B meetings. The meeting package is due "
        "to the FDA 30 days in advance, on 13 October 2026. The package will include the "
        "questions listed in Section 2 along with supporting background materials "
        "summarizing the AXIOM-HN01 study design, interim safety experience, and "
        "proposed regulatory strategy."
    ),
    ("sp-reg-0003", "2. Questions for the Agency"): (
        "This section lists the questions Meridian proposes to discuss with the Division at "
        "the pre-NDA meeting. Question 1 asks whether the proposed OS analysis population "
        "is acceptable for registration. Specifically, the question is whether the PD-L1 "
        "CPS greater than or equal to 1 population, consistent with the protocol-specified "
        "primary endpoint, is an acceptable basis for the primary efficacy claim, or "
        "whether the Division would prefer analyses in the intent-to-treat population as "
        "well. Question 2 asks whether the proposed pediatric study plan components are "
        "adequate given the rarity of this indication in the pediatric population. "
        "Question 3 asks whether the immunogenicity assay validation package is "
        "sufficient. This question addresses whether the planned characterization of "
        "anti-drug antibody incidence and its impact on pharmacokinetics and safety is "
        "adequate, given that revarafusp alfa is a novel bifunctional biologic without a "
        "direct precedent assay. Additional questions concerning the chemistry, "
        "manufacturing, and controls section are provided in Appendix A."
    ),
    # ---- sp-reg-0004: FDA Type B Meeting Minutes ---------------------------
    ("sp-reg-0004", "1. Attendees"): (
        "These minutes document the End of Phase 2 meeting between Meridian Therapeutics "
        "and the FDA regarding the revarafusp alfa development program. The meeting was "
        "held on 08 October 2025 with the FDA Division of Oncology 2. Agency attendees "
        "included the clinical team lead, a statistical reviewer, a pharmacology/"
        "toxicology reviewer, and a regulatory project manager; Meridian attendees included "
        "clinical, regulatory, biostatistics, and nonclinical representatives, along with "
        "an external statistical consultant. The Meridian regulatory lead of record is Alina "
        "Ferreira. They presented the proposed Phase 3 study design and moderated the "
        "discussion of Agency questions. These minutes were prepared by Meridian following "
        "the meeting and were provided to the Division for concurrence within the standard "
        "30-calendar-day timeframe; no substantive corrections were requested by the "
        "Division."
    ),
    ("sp-reg-0004", "2. Agency Feedback"): (
        "This section summarizes the Division's key feedback on the proposed Phase 3 "
        "study design for AXIOM-HN01. The Agency agreed that overall survival is an "
        "acceptable primary endpoint. This position is consistent with prior approvals of "
        "checkpoint-inhibitor-based regimens in recurrent or metastatic HNSCC. The Agency "
        "recommended that progression-free survival be collected as a key secondary "
        "endpoint. The Division noted that a well-controlled secondary analysis of "
        "progression-free survival could support labeling discussions even if not required "
        "for the primary efficacy claim. The Division did not object to the proposed PD-L1 "
        "CPS greater than or equal to 1 analysis population but requested that the "
        "intent-to-treat population also be analyzed and reported. This feedback was "
        "incorporated into AXIOM-HN01 protocol version 4.0, as summarized in that "
        "protocol's Section 6."
    ),
    # ---- sp-saf-0001: Quarterly Safety Report Q2 2026 ----------------------
    ("sp-saf-0001", "2. Aggregate Adverse Events by System Organ Class"): (
        "This section presents aggregate adverse event counts across the revarafusp alfa "
        "program, coded to the Medical Dictionary for Regulatory Activities (MedDRA) "
        "System Organ Class (SOC) level, for the second quarter of 2026. Skin and "
        "subcutaneous tissue disorders were reported in 218 events during Q2 2026. This is "
        "consistent with the known association between EGFR-targeted therapy and "
        "dermatologic toxicity, with acneiform dermatitis, dry skin, and paronychia the "
        "most frequently reported preferred terms within this SOC. Gastrointestinal "
        "disorders were reported in 141 events during Q2 2026. The most common preferred "
        "terms were diarrhea, nausea, and stomatitis, the majority of which were Grade 1 "
        "or Grade 2 in severity and managed with supportive care. Metabolism and nutrition "
        "disorders were reported in 96 events during Q2 2026. This category was dominated "
        "by hypomagnesemia and hypokalemia, consistent with the expected safety profile "
        "described in the current Investigator Brochure. Vascular disorders were reported "
        "in 47 events during Q2 2026. Hypertension was the predominant preferred term, "
        "consistent with the signal evaluation summarized in the 2026 Development Safety "
        "Update Report. Aggregate counts in this section reflect events regardless of "
        "causality assessment and do not include participant-level identifying "
        "information."
    ),
    ("sp-saf-0001", "3. Serious Adverse Events"): (
        "This section summarizes serious adverse events (SAEs) reported across the "
        "revarafusp alfa program during the second quarter of 2026. There were 34 serious "
        "adverse events reported in Q2 2026. These SAEs span both AXIOM-HN01 and "
        "AXIOM-HN02, with disease progression and infection the most frequently "
        "reported SAE categories overall. Six serious adverse events were assessed as "
        "related to revarafusp alfa. The investigator-assessed related events comprised "
        "two cases of Grade 4 infusion-related reaction, two cases of Grade 3 acneiform "
        "dermatitis with secondary infection, one case of Grade 3 hypertension, and one "
        "case of Grade 4 pneumonitis, the latter of which was also reported as a SUSAR and "
        "is detailed further in the SUSAR Line Listing for this quarter. There were no "
        "treatment-related deaths in Q2 2026. All SAEs assessed as related to study "
        "treatment were reviewed by the sponsor's safety physician and reported to "
        "participating regulatory authorities within applicable expedited reporting "
        "timelines."
    ),
    ("sp-saf-0001", "4. Narrative Summaries"): (
        "This section provides brief narrative summaries for the serious adverse events "
        "assessed as related to study treatment during the second quarter of 2026, "
        "prepared to support signal evaluation and Data Monitoring Committee review. "
        "Participant 014-0032, a 61-year-old male, experienced Grade 4 infusion-related "
        "reaction on Cycle 1 Day 1. The infusion was stopped immediately upon onset of "
        "symptoms, the participant was treated with intravenous corticosteroids and "
        "antihistamines, and the event resolved within 24 hours without sequelae; the "
        "participant was withdrawn from study treatment per protocol following a Grade 4 "
        "infusion-related reaction. Participant 027-0011, initials J.M., experienced Grade "
        "3 hypertension requiring dose interruption. Blood pressure was managed with the "
        "addition of a second antihypertensive agent, and study treatment was resumed at "
        "the same dose after blood pressure returned to Grade 1 or lower for two "
        "consecutive assessments. Both events were reported to the site's institutional "
        "review board and to applicable regulatory authorities within expedited reporting "
        "timelines. These narratives contain the minimum participant-level detail required "
        "for safety signal evaluation and are not intended for aggregate reporting "
        "purposes."
    ),
    # ---- sp-saf-0002: DSUR 2026 --------------------------------------------
    ("sp-saf-0002", "3. Cumulative Exposure"): (
        "This Development Safety Update Report (DSUR) covers the reporting period ending "
        "31 March 2026 and summarizes cumulative safety experience across all studies "
        "conducted under IND 145678. Cumulative exposure across the revarafusp alfa "
        "program is 1,284 participant-years as of 31 March 2026. This figure is calculated "
        "from the sum of individual participant treatment durations across AXIOM-HN01, "
        "AXIOM-HN02, and the completed Phase 1 studies that preceded them. It provides "
        "the denominator against which adverse event incidence rates presented elsewhere "
        "in this report should be interpreted, and represents a substantial increase over "
        "the exposure reported in the prior year's DSUR, reflecting the ramp-up of "
        "enrollment in AXIOM-HN01 following the increase in planned enrollment under "
        "protocol version 4.0."
    ),
    ("sp-saf-0002", "6. Signal Evaluation"): (
        "This section documents the formal signal evaluation activities conducted during "
        "the DSUR reporting period, consistent with the sponsor's safety signal management "
        "procedure. Hypertension was evaluated as an emerging safety signal and added to "
        "the reference safety information. This followed a disproportionality analysis and "
        "clinical review that identified a numerically elevated rate of Grade 3 or higher "
        "hypertension relative to background rates and relative to the torilizumab-alone "
        "comparator arm in AXIOM-HN01. The evaluation concluded that a causal "
        "association with revarafusp alfa, mediated by TGF-beta pathway inhibition, was "
        "plausible, resulting in the Investigator Brochure Edition 6 update described "
        "elsewhere in this report. No new signal was identified for hepatotoxicity during "
        "the reporting period. This is despite continued proactive monitoring given the "
        "class-wide association between EGFR-targeted therapies and hepatic transaminase "
        "elevations; liver function test abnormalities observed to date have been "
        "low-grade, transient, and have not met the sponsor's pre-specified signal "
        "evaluation threshold."
    ),
    # ---- sp-saf-0003: SUSAR Line Listing Q2 2026 ---------------------------
    ("sp-saf-0003", "1. Line Listing"): (
        "This line listing documents all Suspected Unexpected Serious Adverse Reactions "
        "(SUSARs) identified across the revarafusp alfa program during the second quarter "
        "of 2026, prepared in accordance with the sponsor's expedited safety reporting "
        "procedure. Three SUSARs were reported in Q2 2026 and all were expedited to the "
        "FDA within 15 calendar days. This timeline is measured from the sponsor becoming "
        "aware of each event, consistent with the 15-calendar-day expedited reporting "
        "requirement for serious, unexpected, and at least reasonably possibly related "
        "adverse events under 21 CFR 312.32. Participant 003-0007, date of birth 14 March "
        "1958, experienced a Grade 4 pneumonitis SUSAR. The event occurred on study day 96 "
        "of AXIOM-HN01, presenting with progressive dyspnea and bilateral ground-glass "
        "opacities on chest computed tomography; it was treated with high-dose "
        "corticosteroids and study treatment was permanently discontinued. The remaining "
        "two SUSARs, detailed in the full line listing appendix, involved Grade 4 "
        "infusion-related reaction and Grade 3 hepatic transaminase elevation with "
        "associated jaundice, respectively, both of which have since resolved."
    ),
    # ---- sp-site-0001: Site US-014 Monitoring Visit Follow-up --------------
    ("sp-site-0001", "1. Visit Summary"): (
        "Dear Dr. Alvarez and Study Team, Thank you for hosting the clinical research "
        "associate during the recent monitoring visit at your site. An interim monitoring "
        "visit was conducted at site US-014 on 18 June 2026. The purpose of the visit was "
        "to perform routine source data verification, review regulatory binder "
        "completeness, and confirm ongoing compliance with the AXIOM-HN01 protocol, "
        "currently version 4.0 at your site. Source data verification was completed for 12 "
        "of 12 enrolled participants. No discrepancies were identified between source "
        "documents and the electronic data capture system that would affect the primary or "
        "key secondary endpoints. The monitor also confirmed that investigational product "
        "accountability logs were complete and that temperature excursion logs showed no "
        "out-of-range storage events during the review period. We appreciate the study "
        "team's continued attention to protocol compliance and data quality, and look "
        "forward to the next scheduled monitoring visit."
    ),
    ("sp-site-0001", "2. Action Items"): (
        "The following action items were identified during the visit and require site "
        "follow-up. Site US-014 must file the updated delegation of authority log within "
        "10 business days. This is needed to reflect the addition of a sub-investigator "
        "who began supporting study visits in May 2026 but had not yet been added to the "
        "delegation log at the time of the visit. Two informed consent forms at site "
        "US-014 require re-consent to Protocol version 4.0. These two participants were "
        "enrolled under protocol version 3.0 and have not yet signed the version 4.0 "
        "informed consent form, despite the protocol amendment having been in effect at "
        "the site since 15 June 2026. Please confirm completion of both action items in "
        "writing to the clinical trial manager within the timeframes noted above. No other "
        "findings from this visit require site action."
    ),
    # ---- sp-site-0002: Site US-027 Protocol Deviation Notice ---------------
    ("sp-site-0002", "1. Deviation Description"): (
        "This notice documents a protocol deviation identified at site US-027 and "
        "reported to the sponsor in accordance with the site's standard operating "
        "procedures. Site US-027 reported a major protocol deviation on 27 May 2026 "
        "involving an out-of-window tumor assessment. The deviation affected a participant "
        "enrolled in AXIOM-HN01 and was discovered during the site's routine review of "
        "upcoming scheduled assessments. The tumor assessment was performed 11 days "
        "outside the protocol-specified window. The delay resulted from a scheduling "
        "conflict with the participant's availability for the required computed "
        "tomography scan, and it was not identified by site staff until after the "
        "assessment had already occurred. The deviation was classified as major because "
        "the assessment supports the primary and key secondary efficacy endpoints, and "
        "out-of-window imaging assessments have the potential to introduce bias into the "
        "timing of efficacy determinations. The sponsor's medical monitor reviewed the "
        "deviation and determined that the resulting imaging data remain evaluable and do "
        "not require the assessment to be excluded from the efficacy analysis."
    ),
    ("sp-site-0002", "2. Corrective and Preventive Action"): (
        "To prevent recurrence of this deviation, the following corrective and preventive "
        "action is required. Site US-027 must retrain all study coordinators on visit "
        "windows by 30 June 2026. Training must cover the protocol-specified visit window "
        "tolerances for all efficacy assessments, the site's process for flagging upcoming "
        "assessments at risk of falling outside the permitted window, and escalation "
        "procedures when a scheduling conflict cannot be resolved within the allowed "
        "window. Documentation of training completion, including sign-in sheets or "
        "electronic training records for every study coordinator, must be filed in the "
        "site regulatory binder and made available to the monitor at the next scheduled "
        "visit. The sponsor's clinical trial manager will follow up with the site prior to "
        "the 30 June 2026 deadline to confirm training has been scheduled."
    ),
    # ---- sp-site-0003: AXIOM Investigator Newsletter June 2026 ----------
    ("sp-site-0003", "1. Protocol Version 4.0 Rollout"): (
        "Dear Investigators, This newsletter provides a program-wide update on the "
        "rollout of AXIOM-HN01 protocol version 4.0 and on overall enrollment progress. "
        "Protocol version 4.0 became effective on 02 June 2026 and all sites must "
        "implement it after IRB approval. Implementation is not permitted prior to local "
        "IRB or ethics committee approval, even at sites that have already received the "
        "amended documents from the sponsor. Sites should submit Protocol version 4.0 to "
        "their IRB within 14 days of receipt. Prompt submission minimizes the gap between "
        "sites operating under different protocol versions and supports timely re-consent "
        "of currently enrolled participants where required. A summary of the key changes "
        "in version 4.0, including the increased enrollment target, the relaxed brain "
        "metastases exclusion criterion, and the new post-infusion observation "
        "requirement, is available in the protocol's Section 6 and was also distributed "
        "separately to site principal investigators."
    ),
    ("sp-site-0003", "2. Enrollment Update"): (
        "We also want to share an enrollment update across the AXIOM-HN01 program. "
        "Cumulative AXIOM-HN01 enrollment reached 366 participants as of 31 May 2026. "
        "This represents steady progress toward the revised target of 528 participants "
        "under protocol version 4.0, and the sponsor anticipates that the increased site "
        "count activated over the coming months will support continued enrollment "
        "momentum. We thank all participating sites for their continued dedication to "
        "timely enrollment and high-quality data collection, and encourage sites that have "
        "not yet reached their individual enrollment targets to reach out to their "
        "clinical trial manager for support with local recruitment strategies. As always, "
        "please do not hesitate to contact the study team with any questions about "
        "protocol version 4.0 or the enrollment update above."
    ),
    # ---- sp-site-0004: Site EU-003 Enrollment Reminder ---------------------
    ("sp-site-0004", "1. Enrollment Status"): (
        "Dear Dr. Lindqvist, We are writing to follow up on enrollment progress at your "
        "site as part of our routine program-wide enrollment review. Site EU-003 has "
        "enrolled 4 participants against a target of 9 participants. This is as of the "
        "most recent enrollment tracker update, placing the site meaningfully behind its "
        "originally projected enrollment curve relative to comparable sites activated in "
        "the same quarter. Site EU-003 is asked to submit a recruitment mitigation plan by "
        "15 July 2026. The plan should describe the specific steps the site intends to "
        "take to improve screening and enrollment rates, such as expanded referral "
        "outreach, additional screening clinics, or adjustments to study visit scheduling "
        "to reduce participant burden. The clinical trial manager is available to discuss "
        "recruitment strategies that have been effective at other sites in the program and "
        "to provide additional recruitment materials if helpful."
    ),
    # ---- sp-ci-0001: HNSCC Competitive Landscape Q2 2026 -------------------
    ("sp-ci-0001", "1. Late-Stage Competitors"): (
        "This landscape update summarizes the late-stage competitive environment in "
        "recurrent or metastatic head and neck squamous cell carcinoma (R/M HNSCC) as of "
        "the second quarter of 2026. Four bispecific programs are in Phase 3 development "
        "for first-line R/M HNSCC as of Q2 2026. This count includes revarafusp alfa and "
        "three competitor molecules targeting overlapping or adjacent mechanisms, "
        "reflecting broad industry conviction that bispecific approaches can outperform "
        "single-agent checkpoint inhibition in this indication. Torilizumab monotherapy "
        "remains the standard of care comparator in first-line PD-L1 positive disease. It "
        "is the active comparator or backbone combination partner in nearly every ongoing "
        "late-stage study in this setting, reinforcing its position as the benchmark "
        "against which new combination regimens must demonstrate meaningful improvement. "
        "Competitive intensity in this indication has increased notably over the past two "
        "years as multiple companies have advanced bispecific and combination strategies "
        "out of Phase 1/2 development into registrational trials."
    ),
    ("sp-ci-0001", "3. Readout Timing"): (
        "Understanding the relative timing of competitor readouts is critical to "
        "anticipating shifts in the competitive and regulatory landscape ahead of Meridian's "
        "own planned submission. The nearest competitor Phase 3 overall survival readout "
        "is projected for the second half of 2027. This estimate is based on publicly "
        "disclosed enrollment timelines and the event-driven design typical of overall "
        "survival studies in this population, and assumes no material change to the "
        "competitor's enrollment pace or assumed control-arm event rate. If this readout "
        "timeline holds, the competitor program would report topline results after "
        "Meridian's planned pre-NDA meeting but potentially before a Meridian NDA submission, "
        "which has implications for the competitive framing of Meridian's regulatory and "
        "commercial strategy discussed in the Market Access Landscape report."
    ),
    # ---- sp-ci-0002: Torilizumab Combination Trials Tracker --------------
    ("sp-ci-0002", "1. Active Combination Studies"): (
        "This tracker catalogs actively enrolling clinical studies combining "
        "torilizumab with an investigational agent in head and neck squamous cell "
        "carcinoma, updated monthly from public trial registries. Twenty-two active "
        "torilizumab combination studies in HNSCC were identified in June 2026. These "
        "studies span a range of combination partners including bispecific antibodies, "
        "antibody-drug conjugates, oncolytic viruses, and small-molecule targeted agents, "
        "reflecting sustained interest in improving on torilizumab monotherapy outcomes "
        "in this indication. Nine of those studies are sponsored by academic consortia. "
        "This is a notably higher academic share than is typical in most solid tumor "
        "indications, likely reflecting strong investigator interest in exploring novel "
        "combination hypotheses ahead of industry-led registrational programs. The full "
        "tracker, including study phase, combination partner mechanism, and estimated "
        "primary completion date for each of the 22 studies, is available in the appendix "
        "to this report."
    ),
    # ---- sp-ci-0003: Competitor Brief - EGFR/LGR5 Bispecific ---------------
    ("sp-ci-0003", "1. Program Overview"): (
        "This brief summarizes publicly available information on a competing bispecific "
        "antibody program targeting EGFR and LGR5 in first-line recurrent or metastatic "
        "HNSCC, one of the four late-stage bispecific competitors identified in the "
        "current competitive landscape update. The competing EGFR/LGR5 bispecific "
        "reported a 63 percent objective response rate in a Phase 2 first-line cohort. "
        "This result was presented at a major oncology conference and is a notably higher "
        "response rate than has historically been observed with torilizumab monotherapy "
        "or chemotherapy-based regimens in this setting, though cross-trial comparisons "
        "should be interpreted cautiously given differences in patient selection and "
        "response assessment methodology. The competing program initiated its Phase 3 "
        "study in March 2026. This is approximately eight months ahead of anticipated "
        "timelines based on the sponsor's prior public guidance, suggesting the sponsor is "
        "prioritizing rapid registrational development following the strong Phase 2 "
        "signal. Meridian's competitive intelligence function will continue to monitor "
        "public disclosures from this program for updates on enrollment pace and study "
        "design."
    ),
    # ---- sp-ci-0004: Market Access Landscape HNSCC 2026 --------------------
    ("sp-ci-0004", "2. Payer Considerations"): (
        "This section summarizes anticipated payer dynamics for a first-line R/M HNSCC "
        "combination regimen based on precedent set by prior checkpoint-inhibitor-based "
        "launches in this and adjacent indications. US payers are expected to require "
        "PD-L1 CPS testing as a coverage condition for combination therapy. This is "
        "consistent with existing coverage policy for torilizumab in this indication, "
        "meaning any future revarafusp alfa combination regimen would likely inherit "
        "similar biomarker-testing coverage requirements rather than facing a novel payer "
        "hurdle. The estimated annualized cost of care for first-line R/M HNSCC "
        "combination therapy is 214,000 US dollars. This estimate is based on wholesale "
        "acquisition cost benchmarking against currently marketed combination regimens in "
        "this indication and typical treatment duration observed in real-world claims "
        "data. Payers are expected to apply standard prior authorization and "
        "step-therapy-adjacent utilization management consistent with existing oncology "
        "combination regimens, and no unusual access barriers specific to a bispecific "
        "mechanism of action are anticipated based on current payer policy trends."
    ),
}


def _front_matter(doc: dict[str, Any]) -> str:
    def _scalar(value: Any) -> str:
        if value is None:
            return "null"
        return f'"{value}"'

    lines = [
        "---",
        f'document_id: {_scalar(doc["document_id"])}',
        f'title: {_scalar(doc["title"])}',
        f'classification: {_scalar(doc["classification"])}',
        f'version: {_scalar(doc["version"])}',
        f'effective_date: {_scalar(doc["effective_date"])}',
        f'site_code: {_scalar(doc.get("site_code"))}',
        f'supersedes: {_scalar(doc.get("supersedes"))}',
        "---",
    ]
    return "\n".join(lines)


def _check_facts_present(doc_id: str, heading: str, facts: list[str], body: str) -> list[str]:
    return [fact for fact in facts if fact not in body]


def render_document(doc: dict[str, Any]) -> str:
    parts = [_front_matter(doc), "", BANNER, ""]
    missing: list[str] = []

    for section in doc["sections"]:
        heading = section["heading"]
        page = section["page"]
        facts = section["facts"]
        body = PROSE.get((doc["document_id"], heading))
        if body is None:
            raise KeyError(
                f"No prose authored for document {doc['document_id']!r} section {heading!r}. "
                "Add an entry to PROSE in scripts/generate_corpus.py."
            )
        missing.extend(
            f"{doc['document_id']} / {heading}: missing fact {fact!r}"
            for fact in _check_facts_present(doc["document_id"], heading, facts, body)
        )
        parts.append(f"## {heading}")
        parts.append(f"<!-- page: {page} -->")
        parts.append("")
        parts.append(body)
        parts.append("")

    if missing:
        raise AssertionError(
            "Generated prose is missing manifest fact strings verbatim:\n" + "\n".join(missing)
        )

    return "\n".join(parts).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify committed corpus files match the manifest without rewriting them.",
    )
    args = parser.parse_args()

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    documents = manifest["documents"]

    mismatches: list[str] = []
    for doc in documents:
        rendered = render_document(doc)
        out_path = CORPUS_DIR / doc["filename"]
        if args.check:
            if not out_path.exists() or out_path.read_text(encoding="utf-8") != rendered:
                mismatches.append(str(out_path))
            continue
        out_path.write_text(rendered, encoding="utf-8")
        print(f"wrote {out_path.relative_to(REPO_ROOT)}")

    if args.check:
        if mismatches:
            print("Corpus is out of date. Regenerate with: python scripts/generate_corpus.py", file=sys.stderr)
            for path in mismatches:
                print(f"  stale: {path}", file=sys.stderr)
            return 1
        print(f"Corpus matches manifest ({len(documents)} documents).")
        return 0

    print(f"Generated {len(documents)} documents into {CORPUS_DIR.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
