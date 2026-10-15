/** Call-bridge campaign registry.
 *
 * When a bridge session's customer number matches a registered campaign
 * target, bringing in the configured newsroom assistant arms it with that
 * office's full dynamic-variable script payload (office, fact, contact,
 * question list) — the same values the hank_dial.py dialer PATCHes onto the
 * assistant before a campaign call. Telnyx ignores dial-level
 * AIAssistantDynamicVariables on the ai_calls path, so the registry values
 * are PATCHed onto the assistant immediately before ai_assistant_start.
 *
 * Keep this registry in sync with mena_campaign_queue.json. The
 * +13466461352 entry maps our own newsroom line to the Mena PD script so
 * the takeover can be rehearsed end-to-end on our own line before it is
 * fired at a real office.
 */

export interface BridgeCampaign {
  dynamicVariables: Record<string, string>;
}

export const BRIDGE_CAMPAIGNS: Record<string, BridgeCampaign> = {
  // Rehearsal line: our own newsroom number arms the Mena PD script so the
  // takeover can be tested end-to-end on our own line before firing at PD.
  '+13466461352': {
    dynamicVariables: {
      desk_name: 'Hank Vance',
      callback_number: '(346) 646-1352',
      recording_mode: 'one_party',
      state_consent_law: 'one-party consent state',
      office: 'Mena Police Department, Mena, Arkansas',
      fact: 'the department\'s handling of the missing-person report for two-year-old Craig Corristan (missing since November 2025), and the March 15, 2026 use-of-force incident at the home of Edward Ross Corristan, the child\'s father, who was pepper-sprayed and arrested by officers at his own house — NOT at the police department. You are NOT asking about the child\'s possible whereabouts. You are asking about the department\'s own actions, records, and protocols.',
      contact_name_or_role: 'Chief Tommy Stueart, or the records custodian if he is unavailable',
      question_list: '1. Under federal law, a missing child report must be entered into NCIC within two hours, with no waiting period allowed. What legal threshold did the department use to determine that a child with an unknown location did not qualify for NCIC entry?\n2. Arkansas law defines interference with court-ordered custody as a Class C felony when someone knowingly keeps a minor from the lawful custodian. Why did responding officers categorize a felony custodial interference allegation as strictly a civil matter?\n3. By what administrative or legal authority does a patrol officer adjudicate a claimed affirmative defense at the lobby counter to deny generating a criminal incident report, rather than submitting an investigative file to the prosecuting attorney?\n4. Organizations like the National Center for Missing and Exploited Children and the Morgan Nick Foundation require an active case number to deploy resources. Does the department acknowledge that refusing to enter the report functionally blocked outside missing-person assistance?\n5. The custody decree ordered law enforcement to assist in the enforcement and recovery of the child. Does the department interpret \'assistance\' as conditional on the reporting parent already possessing the child\'s exact physical address?\n6. When presented with a valid, signed court order awarding sole custody, what written protocol dictates whether the department conducts a welfare or location check versus turning the citizen away to private civil counsel?\n7. On the video, the citizen had his hands open, was backing away, and stated he was leaving when Sgt. Price deployed OC spray and executed a takedown. What articulable physical threat did the citizen pose to justify intermediate use of force?\n8. Given that the interaction originated from an administrative disagreement over filing a police report, what de-escalation techniques were attempted before chemical munitions were deployed?\n9. Why was the subject left in handcuffs on the pavement for over fifteen minutes asking for water and medical assistance while bystanders had to scavenge water bottles from a personal vehicle?\n10. Chief Stueart stated the use of force was reviewed and deemed within policy. Will the department release the internal affairs investigative report, the use-of-force review matrix, and the supervisor sign-offs for this incident?\n11. When citizens enter the police lobby during business hours to request police services or state FOIA forms, under what statutory authority can the Chief or officers threaten criminal trespass arrest for refusing to leave before completing lawful business?\n12. Were all preservation notices honored for the lobby security footage, dash cameras, and body-worn cameras from both the initial desk encounter at the department and the March 15 pepper-spray and arrest at Edward Corristan\'s home?\n13. Did the decision to charge interference with a law enforcement officer stem from actual physical obstruction of an active police duty, or from verbal persistence regarding the filing of a missing-person report?',
    },
  },
  '+14792439600': {
    // Mena Police Department
    dynamicVariables: {
      desk_name: 'Hank Vance',
      callback_number: '(346) 646-1352',
      recording_mode: 'one_party',
      state_consent_law: 'one-party consent state',
      office: 'Mena Police Department, Mena, Arkansas',
      fact: 'the department\'s handling of the missing-person report for two-year-old Craig Corristan (missing since November 2025), and the March 15, 2026 use-of-force incident at the home of Edward Ross Corristan, the child\'s father, who was pepper-sprayed and arrested by officers at his own house — NOT at the police department. You are NOT asking about the child\'s possible whereabouts. You are asking about the department\'s own actions, records, and protocols.',
      contact_name_or_role: 'Chief Tommy Stueart, or the records custodian if he is unavailable',
      question_list: '1. Under federal law, a missing child report must be entered into NCIC within two hours, with no waiting period allowed. What legal threshold did the department use to determine that a child with an unknown location did not qualify for NCIC entry?\n2. Arkansas law defines interference with court-ordered custody as a Class C felony when someone knowingly keeps a minor from the lawful custodian. Why did responding officers categorize a felony custodial interference allegation as strictly a civil matter?\n3. By what administrative or legal authority does a patrol officer adjudicate a claimed affirmative defense at the lobby counter to deny generating a criminal incident report, rather than submitting an investigative file to the prosecuting attorney?\n4. Organizations like the National Center for Missing and Exploited Children and the Morgan Nick Foundation require an active case number to deploy resources. Does the department acknowledge that refusing to enter the report functionally blocked outside missing-person assistance?\n5. The custody decree ordered law enforcement to assist in the enforcement and recovery of the child. Does the department interpret \'assistance\' as conditional on the reporting parent already possessing the child\'s exact physical address?\n6. When presented with a valid, signed court order awarding sole custody, what written protocol dictates whether the department conducts a welfare or location check versus turning the citizen away to private civil counsel?\n7. On the video, the citizen had his hands open, was backing away, and stated he was leaving when Sgt. Price deployed OC spray and executed a takedown. What articulable physical threat did the citizen pose to justify intermediate use of force?\n8. Given that the interaction originated from an administrative disagreement over filing a police report, what de-escalation techniques were attempted before chemical munitions were deployed?\n9. Why was the subject left in handcuffs on the pavement for over fifteen minutes asking for water and medical assistance while bystanders had to scavenge water bottles from a personal vehicle?\n10. Chief Stueart stated the use of force was reviewed and deemed within policy. Will the department release the internal affairs investigative report, the use-of-force review matrix, and the supervisor sign-offs for this incident?\n11. When citizens enter the police lobby during business hours to request police services or state FOIA forms, under what statutory authority can the Chief or officers threaten criminal trespass arrest for refusing to leave before completing lawful business?\n12. Were all preservation notices honored for the lobby security footage, dash cameras, and body-worn cameras from both the initial desk encounter at the department and the March 15 pepper-spray and arrest at Edward Corristan\'s home?\n13. Did the decision to charge interference with a law enforcement officer stem from actual physical obstruction of an active police duty, or from verbal persistence regarding the filing of a missing-person report?',
    },
  },
  '+14793948140': {
    // Polk County District Court (Mena department, Judge Danny Thrailkill)
    dynamicVariables: {
      desk_name: 'Hank Vance',
      callback_number: '(346) 646-1352',
      recording_mode: 'one_party',
      state_consent_law: 'one-party consent state',
      office: 'Polk County District Court, Mena, Arkansas',
      fact: 'public court records questions about cases arising from the March 15, 2026 arrest of Edward Ross Corristan at his own home (pepper-sprayed and arrested by Mena PD) and the handling of his missing-child report for two-year-old Craig Corristan',
      contact_name_or_role: 'the circuit clerk or the court clerk on duty',
      question_list: '1. Is there a criminal case docketed in this court from the March 15, 2026 arrest of Edward Ross Corristan for interference with a law enforcement officer — and what is the case number and next court date? 2. If charges were referred but no case was opened, who is the prosecuting attorney\'s office that screens Polk County referrals, and what is their phone number? 3. What is the process and fee to obtain copies of docket entries and filings in this court? 4. Are juvenile or custody-enforcement filings from this family public record, and if not, what is the statutory exemption?',
    },
  },
  '+14793943271': {
    // Polk County Sheriff's Office (524 Sherwood Ave, Mena)
    dynamicVariables: {
      desk_name: 'Hank Vance',
      callback_number: '(346) 646-1352',
      recording_mode: 'one_party',
      state_consent_law: 'one-party consent state',
      office: 'Polk County Sheriff\'s Office, Mena, Arkansas',
      fact: 'questions about any sheriff\'s office involvement in or records of the March 15, 2026 arrest of Edward Ross Corristan at his own home by Mena PD',
      contact_name_or_role: 'the sheriff, or the records custodian',
      question_list: '1. Did the sheriff\'s office assist Mena PD on March 15, 2026 at Edward Ross Corristan\'s home, and does any deputy-assist report exist? 2. Was Mr. Corristan booked into the Polk County Detention Center following that arrest, and is the booking record releasable under Arkansas FOIA? 3. What is the written FOIA request channel for booking records and any body-camera footage from county deputies? 4. Does the sheriff\'s office have any review or mutual-aid role regarding Mena PD use-of-force incidents?',
    },
  },
  '+18707778944': {
    // Arkansas State Police, CID Company C (covers Polk County)
    dynamicVariables: {
      desk_name: 'Hank Vance',
      callback_number: '(346) 646-1352',
      recording_mode: 'one_party',
      state_consent_law: 'one-party consent state',
      office: 'Arkansas State Police, Criminal Investigation Division, Company C',
      fact: 'follow-up questions on whether ASP has received any referral from Mena PD regarding the missing-child report for two-year-old Craig Corristan or the March 15, 2026 use-of-force incident at Edward Ross Corristan\'s home',
      contact_name_or_role: 'the CID Company C agent on duty or the supervisor',
      question_list: '1. Has CID Company C received any referral from Mena PD regarding the missing-child report for two-year-old Craig Corristan? 2. Can ASP independently verify or enter NCIC information when a local agency declines, and has that happened here? 3. Has ASP received any request to review the March 15, 2026 Mena PD use-of-force incident at Edward Ross Corristan\'s home? 4. Who is ASP\'s FOIA custodian and what is the written-request channel for any ASP records on this matter?',
    },
  },
  '+14793948132': {
    // Polk County Judge Brandon Ellison (courthouse, 507 Church Ave)
    dynamicVariables: {
      desk_name: 'Hank Vance',
      callback_number: '(346) 646-1352',
      recording_mode: 'one_party',
      state_consent_law: 'one-party consent state',
      office: 'Polk County Judge\'s office, Mena, Arkansas',
      fact: 'questions about county oversight and records regarding the March 15, 2026 Mena PD pepper-spray and arrest of Edward Ross Corristan at his own home, and the county jail\'s role that day',
      contact_name_or_role: 'County Judge Brandon Ellison, or his office staff',
      question_list: '1. Does the county exercise any oversight or review role over use-of-force by the Mena Police Department, and if so, has that process been triggered for the March 15, 2026 incident at Edward Ross Corristan\'s home? 2. Was the Polk County Detention Center involved in booking Mr. Corristan on March 15, 2026, and are booking records a county record subject to FOIA? 3. What is the county\'s written FOIA request channel? 4. Who is the county\'s FOIA custodian of record?',
    },
  },
  '+14793948100': {
    // Polk County Circuit Clerk Michelle Heath Schnell
    dynamicVariables: {
      desk_name: 'Hank Vance',
      callback_number: '(346) 646-1352',
      recording_mode: 'one_party',
      state_consent_law: 'one-party consent state',
      office: 'Polk County Circuit Clerk\'s office, Mena, Arkansas',
      fact: 'public-records questions about custody-decree and criminal filings connected to the Corristan family matter and the March 15, 2026 arrest of Edward Ross Corristan',
      contact_name_or_role: 'the circuit clerk or the records clerk on duty',
      question_list: '1. What is the process and fee to obtain copies of circuit court filings, including any custody decree entered for the Corristan child? 2. Is a criminal information or warrant filing from the March 15, 2026 arrest of Edward Ross Corristan on file, and what is the case number? 3. What is the written records-request channel for this office? 4. Can you confirm the phone number for the prosecuting attorney\'s office that handles Polk County criminal cases?',
    },
  },
  '+14793944585': {
    // Mena City Hall / Mayor Seth F. Smith
    dynamicVariables: {
      desk_name: 'Hank Vance',
      callback_number: '(346) 646-1352',
      recording_mode: 'one_party',
      state_consent_law: 'one-party consent state',
      office: 'Mena City Hall, office of Mayor Seth F. Smith, Mena, Arkansas',
      fact: 'questions about the city\'s oversight of the Mena Police Department regarding the missing-person report for two-year-old Craig Corristan and the March 15, 2026 pepper-spray and arrest of Edward Ross Corristan at his own home',
      contact_name_or_role: 'Mayor Seth F. Smith, or the city clerk',
      question_list: '1. What is the city\'s process for reviewing use-of-force by Mena PD officers, and has that process been used for the March 15, 2026 incident at Edward Ross Corristan\'s home? 2. Does the city have a civilian complaint process against police officers, and what is it? 3. What is the city\'s written FOIA request channel for police policies, use-of-force reports, and the internal affairs review? 4. Who is the city\'s FOIA custodian of record?',
    },
  },
  '+14793948123': {
    // Polk County Clerk Lisa McCullen
    dynamicVariables: {
      desk_name: 'Hank Vance',
      callback_number: '(346) 646-1352',
      recording_mode: 'one_party',
      state_consent_law: 'one-party consent state',
      office: 'Polk County Clerk\'s office, Mena, Arkansas',
      fact: 'county records and FOIA channel questions regarding records connected to the March 15, 2026 arrest of Edward Ross Corristan at his own home',
      contact_name_or_role: 'County Clerk Lisa McCullen, or the records clerk on duty',
      question_list: '1. What county records exist regarding the March 15, 2026 Mena PD arrest of Edward Ross Corristan, and which office holds them? 2. What is the written FOIA request channel for county records? 3. Who is the county\'s designated FOIA custodian? 4. Can you confirm the prosecuting attorney\'s office phone number for Polk County criminal referrals?',
    },
  },

  // ── Extended wave targets (added 2026-10-12 from mena_campaign_queue.json) ──
  "+14793946114": {
    // polk-prosecutor
    dynamicVariables: {
  "desk_name": "Hank Vance",
  "callback_number": "(346) 646-1352",
  "recording_mode": "one_party",
  "state_consent_law": "one-party consent state",
  "office": "Polk County Prosecuting Attorney, 18th West Judicial District, Mena, Arkansas",
  "fact": "the department's handling of the missing-person report for two-year-old Craig Corristan (missing since November 2025), and the March 15, 2026 incident where responding officers pepper-sprayed and arrested the child's father, Edward Ross Corristan, AT HIS OWN HOME (never state or imply it happened at the police department or its parking lot)",
  "contact_name_or_role": "Prosecuting Attorney Debra Buschman or the criminal referral screening deputy",
  "question_list": "1. Has your office received a referral or criminal case from the March 15, 2026 Mena PD arrest of Edward Ross Corristan for interference with a law enforcement officer, and if so what is the case number? 2. Arkansas law defines interference with court-ordered custody as a Class C felony when someone knowingly keeps a minor from the lawful custodian. Was a custodial interference referral from the missing-child matter ever submitted to your office for charging review? 3. What is your office screening process when a citizen presents a signed custody decree and asks that a felony custodial interference report be taken? 4. Are you aware of the Mena PD declining to enter a missing two-year-old into NCIC, and does your office have any oversight role in that decision? 5. Will you state on the record whether your office has any open file involving the Corristan family?"
},
  },
  "+15016188000": {
    // asp-hq-lr
    dynamicVariables: {
  "desk_name": "Hank Vance",
  "callback_number": "(346) 646-1352",
  "recording_mode": "one_party",
  "state_consent_law": "one-party consent state",
  "office": "Arkansas State Police Headquarters, Little Rock, Arkansas",
  "fact": "the department's handling of the missing-person report for two-year-old Craig Corristan (missing since November 2025), and the March 15, 2026 incident where responding officers pepper-sprayed and arrested the child's father, Edward Ross Corristan, AT HIS OWN HOME (never state or imply it happened at the police department or its parking lot)",
  "contact_name_or_role": "the CID duty officer, public information officer, or Director's office",
  "question_list": "1. Does CID Company C or any State Police unit currently have any open investigative file or inquiry connected to the missing-person report for two-year-old Craig Corristan of Mena, refused for NCIC entry by Mena PD? 2. What agency policy governs who is responsible for entering a missing-child report into NCIC when a municipal department declines to do so? 3. Is the State Police aware of the March 15, 2026 pepper-spray arrest of Edward Ross Corristan at his own home by Mena PD, and has any use-of-force review been requested at the state level? 4. Who at the state level reviews a department's refusal to take a criminal report of felony custodial interference? 5. Can you provide the name and number of the public information officer authorized to comment on this case?"
},
  },
  "+15012239081": {
    // cotton-lr
    dynamicVariables: {
  "desk_name": "Hank Vance",
  "callback_number": "(346) 646-1352",
  "recording_mode": "one_party",
  "state_consent_law": "one-party consent state",
  "office": "Senator Tom Cotton's Little Rock, Arkansas office",
  "fact": "the department's handling of the missing-person report for two-year-old Craig Corristan (missing since November 2025), and the March 15, 2026 incident where responding officers pepper-sprayed and arrested the child's father, Edward Ross Corristan, AT HIS OWN HOME (never state or imply it happened at the police department or its parking lot)",
  "contact_name_or_role": "the press contact or constituent services staff",
  "question_list": "1. We The People News is reporting that Mena PD refused to enter a missing two-year-old into the FBI's NCIC database, in apparent conflict with the federal two-hour missing-child entry standard. Is the Senator aware of this case, and does he have a comment on federal NCIC compliance standards? 2. Has the office received any constituent complaints regarding the Mena Police Department or the Corristan family matter? 3. What congressional oversight channels exist when a local department appears to ignore federal missing-child reporting requirements? 4. Who in the office handles media inquiries on law enforcement oversight, and can we get a statement on the record? 5. What is the best email or callback line for follow-up from our newsroom?"
},
  },
  "+15013727153": {
    // boozman-lr
    dynamicVariables: {
  "desk_name": "Hank Vance",
  "callback_number": "(346) 646-1352",
  "recording_mode": "one_party",
  "state_consent_law": "one-party consent state",
  "office": "Senator John Boozman's Little Rock, Arkansas office",
  "fact": "the department's handling of the missing-person report for two-year-old Craig Corristan (missing since November 2025), and the March 15, 2026 incident where responding officers pepper-sprayed and arrested the child's father, Edward Ross Corristan, AT HIS OWN HOME (never state or imply it happened at the police department or its parking lot)",
  "contact_name_or_role": "the press contact or constituent services staff",
  "question_list": "1. We The People News is reporting that Mena PD refused to enter a missing two-year-old into NCIC, in apparent conflict with federal standards requiring prompt missing-child entry. Does the Senator have a comment on this case from his home state? 2. Has the office received constituent complaints about the Mena Police Department or the Corristan matter? 3. What can a U.S. Senate office do when an Arkansas family says a police department refused to take or forward a missing-child report? 4. Who handles media inquiries for law enforcement oversight matters, and can we get a statement on the record? 5. What is the best callback line for our newsroom?"
},
  },
  "+15016099796": {
    // westerman-hs
    dynamicVariables: {
  "desk_name": "Hank Vance",
  "callback_number": "(346) 646-1352",
  "recording_mode": "one_party",
  "state_consent_law": "one-party consent state",
  "office": "Congressman Bruce Westerman's Hot Springs, Arkansas district office (AR-4, which includes Mena and Polk County)",
  "fact": "the department's handling of the missing-person report for two-year-old Craig Corristan (missing since November 2025), and the March 15, 2026 incident where responding officers pepper-sprayed and arrested the child's father, Edward Ross Corristan, AT HIS OWN HOME (never state or imply it happened at the police department or its parking lot)",
  "contact_name_or_role": "the district director or constituent services staff",
  "question_list": "1. The Corristan family lives in your district. We The People News is reporting that Mena PD refused to enter their missing two-year-old into NCIC, and that the child's father was pepper-sprayed and arrested at his own home after asking for the report. Has the Congressman's office been contacted about this? 2. Can the office open a constituent-services inquiry on behalf of the family regarding the refused missing-child report? 3. Does the Congressman have a comment on a local department appearing to ignore federal missing-child reporting standards in his own district? 4. Who handles media inquiries in the district office, and can we get a statement on the record? 5. What is the best callback line for our newsroom?"
},
  },
  "+17032242150": {
    // ncmec-hq
    dynamicVariables: {
  "desk_name": "Hank Vance",
  "callback_number": "(346) 646-1352",
  "recording_mode": "one_party",
  "state_consent_law": "one-party consent state",
  "office": "The National Center for Missing and Exploited Children, headquarters, Alexandria, Virginia",
  "fact": "the department's handling of the missing-person report for two-year-old Craig Corristan (missing since November 2025), and the March 15, 2026 incident where responding officers pepper-sprayed and arrested the child's father, Edward Ross Corristan, AT HIS OWN HOME (never state or imply it happened at the police department or its parking lot)",
  "contact_name_or_role": "media relations or case services staff",
  "question_list": "1. We The People News is reporting that an Arkansas police department refused to enter a missing two-year-old into NCIC. From NCMEC's experience, what does a refusal like that mean for the family's access to national missing-child resources like yours? 2. Does NCMEC require an active law enforcement case number before it can deploy search and family support resources? 3. What should a parent do when a department refuses to take or enter a missing-child report? 4. Is NCMEC aware of or involved in the Craig Corristan case out of Mena, Arkansas? 5. Can we get a statement on the record for our reporting, and what is the best media contact line?"
},
  },
  "+18775434673": {
    // morgan-nick
    dynamicVariables: {
  "desk_name": "Hank Vance",
  "callback_number": "(346) 646-1352",
  "recording_mode": "one_party",
  "state_consent_law": "one-party consent state",
  "office": "The Morgan Nick Foundation, Alma, Arkansas",
  "fact": "the department's handling of the missing-person report for two-year-old Craig Corristan (missing since November 2025), and the March 15, 2026 incident where responding officers pepper-sprayed and arrested the child's father, Edward Ross Corristan, AT HIS OWN HOME (never state or imply it happened at the police department or its parking lot)",
  "contact_name_or_role": "a caseworker or Colleen Nick's office",
  "question_list": "1. We The People News is reporting on an Arkansas case where a police department refused to enter a missing two-year-old into NCIC. From the foundation's two decades of missing-children work in Arkansas, what does that refusal do to a family's chances? 2. What does the Morgan Nick Foundation need before it can deploy search and support resources for an Arkansas family? 3. Have you been contacted about the Craig Corristan case out of Mena? 4. What should Arkansas parents do when a department refuses to take a missing-child report? 5. Can we get a statement or interview with Colleen Nick for our reporting?"
},
  },
  "+15016822345": {
    // governor-lr
    dynamicVariables: {
  "desk_name": "Hank Vance",
  "callback_number": "(346) 646-1352",
  "recording_mode": "one_party",
  "state_consent_law": "one-party consent state",
  "office": "The Arkansas Governor's office, Little Rock, Arkansas",
  "fact": "the department's handling of the missing-person report for two-year-old Craig Corristan (missing since November 2025), and the March 15, 2026 incident where responding officers pepper-sprayed and arrested the child's father, Edward Ross Corristan, AT HIS OWN HOME (never state or imply it happened at the police department or its parking lot)",
  "contact_name_or_role": "the constituent services office or the Governor's press office",
  "question_list": "1. We The People News is reporting that a Mena police department refused to enter a missing two-year-old into the FBI NCIC database, and that the child's father was pepper-sprayed and arrested at his own home after requesting the report. Has the Governor's office received any complaint regarding this case? 2. Does the Governor have a comment on a local department appearing to ignore federal missing-child reporting standards in Arkansas? 3. What oversight channels does the state have over municipal police departments in cases like this? 4. Who in the press office can give us a statement on the record? 5. What is the best callback line for our newsroom?"
},
  },
};

export function campaignForCustomer(customerNumber: string): BridgeCampaign | null {
  return BRIDGE_CAMPAIGNS[customerNumber] ?? null;
}
