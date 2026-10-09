import os


class TDXLURepointExt:
	"""Repoint relative asset paths that broke when the .toe changed folders.

	The canonical case is a TD backup: Backup/Project.12.toe sits one level
	below the folder it was saved from, so every project-relative reference
	('assets/clip.mov') now resolves INSIDE Backup/ and misses. This finds
	those refs and rewrites them to the level that actually holds the file
	('../assets/clip.mov').

	Symmetric on purpose: it equally strips leading '../' from refs that
	were repointed inside Backup/ and then copied back up to the project
	folder, so a round trip is always one click from correct.

	Scope is deliberately narrow - constant-mode File/Folder parameters
	holding a RELATIVE path whose current resolution does not exist on
	disk. Absolute paths are a different failure (the asset moved, not the
	.toe) and are left alone. Expression / bind / export refs are reported
	but never rewritten: baking those would detach live wiring rather than
	just re-root a value. Embody-managed synced DAT sources and externaltox
	refs are skipped outright - both are infrastructure whose paths belong
	to the tooling that wrote them.

	NOTHING IS SAVED. The rewrite lands in the running session only, so the
	backup on disk stays byte-for-byte as it was; if the user goes on to
	save, the fix persists with their save. That is the design, not an
	oversight: a saved '../' path is correct ONLY while the .toe sits in
	Backup/, and breaks again the moment the file is copied back up beside
	the project.
	"""

	# Folder levels searched in each direction. A backup is one level; three
	# covers hand-made nesting without turning the scan into a disk crawl.
	_MAX_LEVELS = 3

	# Par styles that hold a filesystem path, and how to test each one.
	_PATH_STYLES = ('File', 'Folder')

	def __init__(self, ownerComp):
		self.ownerComp = ownerComp

	# --- helpers ------------------------------------------------------------

	def _projectRoot(self):
		return project.folder.replace('\\', '/').rstrip('/')

	def _excludedPrefixes(self):
		"""Op-path prefixes the scan must not touch: self, and the TDXLU
		companion when present (its own file pars are infrastructure)."""
		roots = [self.ownerComp.path]
		companion = getattr(op, 'TDXLU', None)
		if companion is not None:
			roots.append(companion.path)
		return tuple(roots), tuple(r + '/' for r in roots)

	def _resolvesFromProject(self, raw, resolved):
		"""Did TD resolve this ref against project.folder?

		A ref inside an external .tox can resolve against the .tox instead,
		depending on that COMP's Asset Path setting. Rewriting one of those
		against the project root would produce a path that reads correctly
		and still misses, so confirm the root by replaying the join TD must
		have done and only claim the ones that match.
		"""
		try:
			replay = os.path.normpath(os.path.join(self._projectRoot(), raw))
			return os.path.normcase(replay) == os.path.normcase(
				os.path.normpath(resolved)
			)
		except Exception:
			return False

	def _candidates(self, raw):
		"""Relative rewrites to try, nearest level first.

		Climbing handles a .toe that moved DOWN a level (the backup case);
		stripping handles one that moved back UP.
		"""
		rel = raw.replace('\\', '/')
		while rel.startswith('./'):
			rel = rel[2:]
		out = ['../' * k + rel for k in range(1, self._MAX_LEVELS + 1)]
		stripped = rel
		for _ in range(self._MAX_LEVELS):
			if not stripped.startswith('../'):
				break
			stripped = stripped[3:]
			out.append(stripped)
		return out

	def _context(self):
		"""What the caller needs to explain the situation to a user."""
		folder = self._projectRoot()
		return {
			'project_folder': folder,
			'project_file': project.name,
			'in_backup_folder': os.path.basename(folder).lower() == 'backup',
		}

	# --- scan ---------------------------------------------------------------

	def _scan(self):
		"""One bounded pass over the project; returns the repoint plan."""
		proj = self._projectRoot()
		exact_excludes, prefix_excludes = self._excludedPrefixes()
		fixes = []
		unresolved = []
		skipped = []
		counts = {
			'ok': 0, 'absolute': 0, 'sync': 0, 'externaltox': 0,
			'url': 0, 'sequence': 0, 'empty': 0, 'foreign_root': 0,
		}
		for o in root.findChildren(maxDepth=None):
			opath = o.path
			seg = opath.split('/', 2)[1] if '/' in opath else ''
			# /local is TD-managed project config (shortcuts, mappings);
			# re-rooting refs there breaks TD's own resolution.
			if seg in ('sys', 'ui', 'local'):
				continue
			if opath in exact_excludes or opath.startswith(prefix_excludes):
				continue
			try:
				sp = getattr(o.par, 'syncfile', None)
				synced = bool(sp.eval()) if sp is not None else False
			except Exception:
				synced = False
			for p in o.pars():
				try:
					if p.style not in self._PATH_STYLES:
						continue
					if p.name == 'externaltox':
						counts['externaltox'] += 1
						continue
					if synced and p.name == 'file':
						counts['sync'] += 1  # Embody-managed source file
						continue
					try:
						raw = str(p.eval() or '').strip()
					except Exception:
						# Broken expression upstream - not ours to report
						# par-by-par, and not ours to rewrite either.
						continue
					if not raw:
						counts['empty'] += 1
						continue
					low = raw.lower()
					if low.startswith(('http://', 'https://', 'virtualfile:')):
						counts['url'] += 1
						continue
					if any(tok in raw for tok in ('$F', '%0', '*')):
						counts['sequence'] += 1
						continue
					if os.path.isabs(raw) or raw[0] in '~$':
						# The .toe moving folders cannot break an absolute
						# ref; if it misses, the asset moved instead.
						counts['absolute'] += 1
						continue
					exists = os.path.isdir if p.style == 'Folder' else os.path.isfile
					fi = p.evalFile()
					resolved = str(fi) if fi is not None else ''
					if not resolved:
						continue
					if exists(resolved):
						counts['ok'] += 1
						continue
					if not self._resolvesFromProject(raw, resolved):
						counts['foreign_root'] += 1
						skipped.append({
							'op': opath, 'par': p.name, 'value': raw,
							'reason': 'resolves against a non-project root',
						})
						continue
					if p.mode != ParMode.CONSTANT:
						skipped.append({
							'op': opath, 'par': p.name, 'value': raw,
							'reason': f'{p.mode.name.lower()} mode (not rewritten)',
						})
						continue
					hit = None
					for cand in self._candidates(raw):
						cand_abs = os.path.normpath(os.path.join(proj, cand))
						if exists(cand_abs):
							hit = (cand, cand_abs)
							break
					if hit is None:
						unresolved.append({
							'op': opath, 'par': p.name, 'value': raw,
							'resolved': resolved.replace('\\', '/'),
						})
						continue
					fixes.append({
						'ref': f'{opath}.{p.name}',
						'op': opath, 'par': p.name,
						'from': raw, 'to': hit[0],
						'file': hit[1].replace('\\', '/'),
						'name': os.path.basename(hit[1].rstrip('/\\')),
					})
				except Exception as e:
					skipped.append({
						'op': opath, 'par': getattr(p, 'name', '?'),
						'reason': f'scan error: {e}',
					})
		return {
			'fixes': fixes,
			'unresolved': unresolved,
			'skipped': skipped,
			'counts': counts,
			'count': len(fixes),
			**self._context(),
		}

	# --- apply --------------------------------------------------------------

	def _rewrite(self, fix):
		"""Re-root one par. Returns an error string, or None on success.

		Every precondition from the scan is re-checked here: a plan is a
		snapshot, and the network can move underneath it between the
		dry-run and the confirmation.
		"""
		ref = fix.get('ref') or f'{fix.get("op")}.{fix.get("par")}'
		o = op(fix.get('op') or '')
		if o is None:
			return f'{ref}: op vanished'
		pl = o.pars(fix.get('par') or '')
		if not pl:
			return f'{ref}: par vanished'
		p = pl[0]
		if p.mode != ParMode.CONSTANT:
			return f'{ref}: no longer constant'
		try:
			if str(p.eval() or '').strip() != fix.get('from'):
				return f'{ref}: value changed since the scan'
		except Exception as e:
			return f'{ref}: {e}'
		target = fix.get('file') or ''
		if not (os.path.isfile(target) or os.path.isdir(target)):
			return f'{ref}: {target} is gone'
		p.val = fix.get('to')
		return None

	def RepointAssets(self, dry_run=False, include=None):
		"""Re-root relative refs the .toe's folder move broke.

		dry_run=True returns the plan and touches nothing. include, when
		given, is the list of '<op path>.<par>' refs the caller confirmed -
		anything else is left alone, so refs that appear between the
		dry-run and the apply are never silently swept in. The apply is
		synchronous (it only assigns parameters, it copies no files) and
		deliberately does NOT save the project.
		"""
		try:
			plan = self._scan()
		except Exception as e:
			return {'ok': False, 'error': str(e)}
		if dry_run:
			return {'ok': True, 'dry_run': True, **plan}
		fixes = plan['fixes']
		if include is not None:
			allowed = {str(s) for s in include}
			fixes = [f for f in fixes if f['ref'] in allowed]
		applied = []
		errors = []
		for f in fixes:
			err = self._rewrite(f)
			if err:
				errors.append(err)
			else:
				applied.append(f)
		msg = f'Repointed {len(applied)} of {len(fixes)} ref(s) (not saved)'
		if errors:
			msg += f'; {len(errors)} failed'
		try:
			print(f'[TDXLURepoint] {msg}')
		except Exception:
			pass
		return {
			'ok': True,
			'saved': False,
			'applied': applied,
			'errors': errors,
			'count': len(applied),
			'attempted': len(fixes),
			'unresolved': plan['unresolved'],
			'skipped': plan['skipped'],
			'message': msg,
			**self._context(),
		}
