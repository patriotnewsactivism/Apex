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
};

export function campaignForCustomer(customerNumber: string): BridgeCampaign | null {
  return BRIDGE_CAMPAIGNS[customerNumber] ?? null;
}
