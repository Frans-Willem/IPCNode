(function() {
function IDProviderModule(exports) {
	function IDProvider() {
		this._free=[{from: 0, to: NaN}];
	}

	/**
	 * Allocates a new ID number to use.
	 * @author fw@hardijzer.nl
	 * @return The lowest un-used ID number
	 */
	IDProvider.prototype.alloc=function() {
		var first=this._free[0];
		if (first.from==first.to) {
			//Discard range
			this._free.shift();
			return first.from;
		}
		return first.from++;
	};

	/**
	 * Free an allocated ID for re-use.
	 * @author fw@hardijzer.nl
	 * @param {id} ID number to free.
	 */
	IDProvider.prototype.free=function(id) {
		//Binary search
		var left=0,
			right=this._free.length,
			mid,current,mergeleft,mergeright;
		while (right>left) {
			mid=Math.floor((left+right)/2);
			current=this._free[mid];
			if (current.from>id) {
				right=mid;
			} else if (current.to<id) {
				left=mid+1;
			} else {
				throw new Error("ID was already de-allocated");
			}
		}
		//both left and right now contain the range just past our id.
		//Set left to point to the one before, keep right just past
		left--;
		mergeleft=(left>=0 && this._free[left].to==id-1);
		mergeright=(right<this._free.length && this._free[right].from==id+1);
		if (mergeleft && mergeright) {
			//Merge two ranges into one new range
			this._free[left].to=this._free[right].to;
			this._free.splice(right,1);
		} else if (mergeleft) {
			this._free[left].to=id;
		} else if (mergeright) {
			this._free[right].from=id;
		} else {
			//Create new range inbetween
			this._free.splice(right,0,{from:id,to:id});
		}
	};

	IDProvider.prototype.used=function() {
		var total=0,
			last=0,
			i,cur;
		for (i=0; i<this._free.length; i++) {
			cur=this._free[i];
			total+=cur.from - last;
			last=cur.to+1;
		}
		return total;
	};

	exports.IDProvider=IDProvider;
}
if (typeof(exports)==="object" && typeof(require)==="function") {
	IDProviderModule(exports);
} else if (typeof(window)==="object") {
	IDProviderModule(window);
}
})();