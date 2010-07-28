var sys=require("sys");
var EventEmitter=require("events").EventEmitter;
var IDProvider=require("./IDProvider").IDProvider;

function IPCNode() {
	EventEmitter.call(this);
	this._pauseBuffer=[];
	this._buffer="";
	this._idp=new IDProvider();
	this._localobjects={};
	this._remoteobjects={};
	this._requesting={};
	this._id=IPCNode._idp.alloc();
}

IPCNode._idp=new IDProvider();

//Readable stream
function Base(){};
Base.prototype=EventEmitter.prototype;
IPCNode.prototype=new Base();
IPCNode.prototype._closed=false;
IPCNode.prototype._paused=false;
IPCNode.prototype._pauseBuffer=undefined; //Should be set in constructor
IPCNode.prototype.readable=true;
IPCNode.prototype.setEncoding=function(encoding) {}; //Ignore for now
IPCNode.prototype.pause=function() {
	this._paused=true;
}
IPCNode.prototype.resume=function() {
	this._paused=false;
	while (!this._paused && this._pauseBuffer.length>0)
		this.emit("data",this._pauseBuffer.shift());
}
IPCNode.prototype.destroy=function() {
	this.end();
}
//Writeable stream
IPCNode.prototype._buffer=undefined; //Should be set in constructor
IPCNode.prototype.writeable=true;
IPCNode.prototype.write=function(string,encoding) {
	if (string===undefined)
		return true;
	if (this._closed)
		throw new Error("IPCNode was closed, unable to write: "+string);
	this._buffer+=string;
	var split;
	while ((split=this._buffer.indexOf("\n"))!==-1) {
		var line=this._buffer.substr(0,split);
		this._buffer=this._buffer.substr(split+1);
		try {
			this._onData(line);
		}
		catch(e) {
			this._emitError(e);
		}
	}
	return true;
}
IPCNode.prototype.end=function(string,encoding) {
	if (this._closed)
		return;
	this.write.apply(this,Array.prototype.slice.call(arguments,0));
	this._closed=true;
	this.writeable=false;
	this.readable=false;
	this.emit("end");
	this.emit("close");
}
//See Readable Stream for destroy
//Custom functions
IPCNode.prototype._isClean=function() {
	//this._localobjects and this._remoteobjects should be empty.
	return (
		!Object.keys(this._localobjects).some(function(x) { return x==parseInt(x); }) &&
		!Object.keys(this._requesting).some(function(x) { return x==parseInt(x); }) &&
		!Object.keys(this._remoteobjects).some(function(x) { return x==parseInt(x); })
	);
}
IPCNode.prototype._cleanup=function() {
	//TODO: Clean up all marshalled objects
}
IPCNode.prototype._emitError=function(err) {
	this._closed=true;
	this.emit("error",err);
}
IPCNode.prototype._emitCommand=function(cmd) {
	this._emitData(JSON.stringify(cmd)+"\n");
}
IPCNode.prototype._emitData=function(data) {
	if (this._closed)
		throw new Error("IPCNode is closed");
	if (!this._paused) this.emit("data",data);
	else {
		if (typeof(this._pauseBuffer)!=="object")
			this._pauseBuffer=[];
		this._pauseBuffer.push(data);
	}
}
IPCNode.prototype._onData=function(data) {
	if (this._closed)
		throw new Error("IPCNode is closed");
	try {
		return this._onCommand(JSON.parse(data));
	}
	catch(e) {
		this._emitError(e);
	}
}
IPCNode.prototype._onCommand=function(cmd) {
	switch (cmd.m) {
		//Response
		case "rs":
			this._onResponse(cmd.i,cmd.t,cmd.p);
			break;
		//Request
		case "rq":
			this._onRequest(cmd.i);
			break;
		//Release
		case "rl":
			this._onRelease(cmd.i);
			break;
		//Call
		case "c":
			this._onCall(cmd.f,cmd.t,cmd.a);
			break;
		//Register
		case "rg":
			this._onRegister(cmd.n,cmd.o);
			break;
		default:
			throw new Error("Unknown method: "+m);
	}
}
IPCNode.prototype._onRelease=function(id) {
	var info=this._localobjects[parseInt(id)];
	if (typeof(info)!=="object")
		throw new Error("Unknown ID: "+id);
	if (--info.refcount == 0) {
		//Release it completely
		delete info.object["__ipcinfo_"+this._id];
		delete this._localobjects[id];
		this._idp.free(id);
	}
	if (this._isClean())
		this.emit("clean");
}
IPCNode.prototype._onRequest=function(id) {
	var self=this;
	var info=self._localobjects[parseInt(id)];
	if (typeof(info)!=="object")
		throw new Error("Unknown ID: "+id);
	var props={};
	var obj=info.object;
	var type=typeof(obj);
	var res={m:"rs",i:id,t: type.substr(0,1),p: props};
	var todo=1;
	function checkDone() {
		if (todo==0)
			self._emitCommand(res);
	}
	for (var i in obj) {
		var x=obj[i];
		if (i.substr(0,2)!=="__" && (typeof(x)==="object" || typeof(x)==="function") && x!==null) {
			todo++;
			self._marshalObject(x,(function(i) {
				return function(m) {
					props[i]=m;
					todo--;
					checkDone();
				}
			})(i));
		}
	}
	todo--;
	checkDone();
}
IPCNode.prototype._onResponse=function(id,type,props) {
	var id=parseInt(id);
	var req=this._requesting[id];
	if (typeof(req)!=="object")
		throw new Error("Invalid request ID in response")
	delete this._requesting[id];
	var info={type:type,props:props,refcount:1};
	this._remoteobjects[id]=info;
	while (req.length)
		req.shift()(info);
	this._releaseRemoteId(id,info);
}
IPCNode.prototype._marshalObject=function(o,callback) {
	var info=o["__ipcinfo_"+this._id];
	if (typeof(info)==="object") {
		if (info.owner) {
			this._localobjects[info.id].refcount++;
			return callback({o:true,i:info.id});
		} else {
			return callback({o:false,i:info.id});
		}
	} else {
		//Allocate new
		info={owner:true,id:this._idp.alloc()};
		o["__ipcinfo_"+this._id]=info;
		this._localobjects[info.id]={
			refcount: 1,
			object: o
		};
		return callback({o:true,i:info.id});
	}
}
IPCNode.prototype._marshal=function(o,callback) {
	if (Array.isArray(o)) {
		var self=this;
		var todo=1;
		var ret=[];
		function checkDoneArr() {
			try {
				if (todo==0)
					callback(ret);
			}
			catch(e) {
				self._emitError(e);
			}
		}
		for (var i=0; i<o.length; i++) {
			this._marshal(o[i],(function(i) {
				return function(m) {
					ret[i]=m;
					todo--;
					checkDoneArr();
				}
			})(i));
		}
		todo--;
		checkDoneArr();
		return;
	}
	if (o===null || o===undefined || typeof(o)==="number" || typeof(o)==="string" || typeof(o)==="boolean")
		return callback(o);
	if (typeof(o)==="object") {
		var has_functions=Object.keys(o).some(function(x) { return ((typeof(o[x])==="function") && (Object.prototype[x] !== o[x])); });
		if (has_functions) {
			return this._marshalObject(o,function(m) {
				callback({t:"o",o:m});
			});
		} else {
			var self=this;
			var todo=1;
			var ret={};
			function checkDoneObj() {
				try {
					if (todo==0)
						callback({t:"j",o:ret});
				}
				catch(e) {
					self._emitError(e);
				}
			}
			for (var i in o) {
				this._marshal(o[i],(function(i) {
					return function(m) {
						ret[i]=m;
						todo--;
						checkDoneObj();
					}
				})(i));
			}
			todo--;
			checkDoneObj();
			return;
		}
	}
	if (typeof(o)==="function") {
		return this._marshalObject(o,function(m) {
			callback({t:"o",o:m});
		});
	}
	throw new Error("Unable to marshal value: "+o);
}
function getGlobal() {
	return (function(){return this;})();
}
IPCNode.prototype._call=function(f,t,args) {
	if (this._closed)
		throw new Error("IPCNode was closed");
	var marshalledArgs=[];
	var marshalledF=undefined;
	var marshalledT=undefined;
	var todo=1;
	var self=this;
	function checkDone() {
		try {
			if (todo==0)
				self._emitCommand({m:"c",f:marshalledF,t:marshalledT,a:marshalledArgs});
		}
		catch(e) {
			self._emitError(e);
		}
	}
	todo++;
	//Marshal function
	self._marshalObject(f,function(m) {
		marshalledF=m;
		todo--;
		checkDone();
	});
	//Marshal this
	if (t===null || t===undefined || typeof(t)==="string") {
		marshalledT={t:"d",v:t};
	} else if (t===getGlobal()) {
		marshalledT={t:"g"};
	} else if (typeof(t)==="object") {
		todo++;
		self._marshal(t,function(m) {
			marshalledT={t:"m",m:m};
			todo--;
			checkDone();
		});
	}
	//Marshal arguments
	for (var i=0; i<args.length; i++) {
		todo++;
		self._marshal(args[i],(function(i) {
			return function(m) {
				marshalledArgs[i]=m;
				todo--;
				checkDone();
			}
		})(i));
	}
	todo--;
	checkDone();
}
IPCNode.prototype._onCall=function(f,t,args) {
	var todo=1;
	var unmarshalledArgs=[];
	var unmarshalledF=undefined;
	var unmarshalledT=undefined;
	var self=this;
	function checkDone() {
		try {
			if (todo==0) {
				unmarshalledF.apply(unmarshalledT,unmarshalledArgs);
				IPCNode.dispose(unmarshalledF);
				IPCNode.dispose(unmarshalledT);
				for (var i=0; i<unmarshalledArgs.length; i++)
					IPCNode.dispose(unmarshalledArgs[i]);
			}
		}
		catch(e) {
			self._emitError(e);
		}
	}
	todo++;
	this._unmarshalObject(f,function(um) {
		unmarshalledF=um;
		todo--;
		checkDone();
	},true);
	if (t.t==="d")
		unmarshalledT=t.v;
	else if (t.t==="g")
		unmarshalledT=getGlobal();
	else if (t.t==="m") {
		todo++;
		this._unmarshal(t.m,function(um) {
			unmarshalledT=um;
			todo--;
			checkDone();
		},true);
	}
	else throw new Error("Unable to unmarshal 'this' from "+t);
	for (var i=0; i<args.length; i++) {
		todo++;
		this._unmarshal(args[i],(function(i) {
			return function(um) {
				unmarshalledArgs[i]=um;
				todo--;
				checkDone();
			}
		})(i),true);
	}
	todo--;
	checkDone();
}
IPCNode.prototype._unmarshalLocalObject=function(id,callback,releaseDuplicate) {
	//Unmarshal an object on my side
	var info=this._localobjects[parseInt(id)];
	if (typeof(info)!=="object")
		throw new Error("Unknown local id "+id);
	callback(info.object);
}
IPCNode.prototype._releaseRemoteId=function(id,info) {
	//Do nothing for now
	id=parseInt(id);
	if (typeof(info)!=="object")
		throw new Error("Unhandled error on releasing");
	if (--info.refcount == 0) {
		delete this._remoteobjects[id];
		this._emitCommand({m:"rl",i:id});
	}
	if (this._isClean())
		this.emit("clean");
}
function createIPCFunction() {
	return function() {
		var f=arguments.callee;
		var owner=f.__ipc_owner;
		if (typeof(owner)!=="object")
			throw new Error("Function has been disposed");
		owner._call(f,this,Array.prototype.slice.call(arguments));
	}
}
IPCNode.reference=function(obj) {
	var owner=obj.__ipc_owner;
	if (typeof(owner)!=="object")
		return obj;
	var ret;
	//Will call back immediatly seeing as all info should be readily available
	owner._createRemoteObject(obj.__ipc_remote_id,obj.__ipc_owner_info,function(r) {
		ret=r;
	},false);
	return ret;
}
IPCNode.dispose=function(obj) {
	if (obj.__ipc_disposed)
		throw new Error("IPC object already disposed");
	var owner=obj.__ipc_owner;
	if (typeof(owner)!=="object")
		return;
	var info=obj.__ipc_owner_info;
	var id=obj.__ipc_remote_id;
	var children=obj.__ipc_children;
	delete obj.__ipc_owner;
	delete obj.__ipc_owner_info;
	delete obj.__ipc_remote_id;
	delete obj.__ipc_children;
	delete obj["__ipcinfo_"+owner._id];
	obj.__ipc_disposed=true;
	owner._releaseRemoteId(id,info);
	for (var i=0; i<children.length; i++) {
		try {
			IPCNode.dispose(children[i]);
		}
		catch(e) {
		
		}
	}
}
IPCNode.prototype._createRemoteObject=function(id,info,callback,releaseDuplicate) {
	if (this._closed)
		throw new Error("IPCNode was closed");
	var ret;
	if (info.type==="f") ret=createIPCFunction();
	else if (info.type==="o") ret={};
	else throw new Error("Type "+t+" not supported");
	info.refcount++;
	var self=this;
	ret.__ipc_disposed=false;
	ret.__ipc_owner=self;
	ret.__ipc_owner_info=info;
	ret.__ipc_remote_id=id;
	ret.__ipc_children=[];
	ret["__ipcinfo_"+self._id]={owner:false,id:id};
	var props=info.props;
	var todo=1;
	function checkDone() {
		if (todo==0)
			callback(ret);
	}
	for (var propname in props) {
		if (propname.substr(0,2)=="__")
			continue;
		todo++;
		self._unmarshalObject(props[propname],(function(propname) {
			return function(propvalue) {
				ret[propname]=propvalue;
				ret["__ipc_children"].push(propvalue);
				todo--;
				checkDone();
			}
		})(propname),releaseDuplicate);
	}
	todo--;
	checkDone();
}
IPCNode.prototype._unmarshalRemoteObject=function(id,callback,releaseDuplicate) {
	//Unmarshal an object on the other side
	var id=parseInt(id);
	var self=this;
	function onInfo(info) {
		self._createRemoteObject(id,info,callback,releaseDuplicate);
	}
	var existing=this._remoteobjects[id];
	if (typeof(existing)=="object") {
		//Send a release command, we already have a reference that we're holding on to
		if (releaseDuplicate)
			this._emitCommand({m:"rl",i:id});
		return onInfo(existing);
	}
	var requesting=this._requesting[id];
	if (typeof(requesting)=="object")
		requesting.push(onInfo);
	this._requesting[id]=[onInfo];
	this._emitCommand({m:"rq",i:id});
}
IPCNode.prototype._unmarshalObject=function(info,callback,releaseDuplicate) {
	if (info.o) this._unmarshalRemoteObject(info.i,callback,releaseDuplicate);
	else this._unmarshalLocalObject(info.i,callback,releaseDuplicate);
}
IPCNode.prototype._unmarshal=function(o,callback,releaseDuplicate) {
	if (Array.isArray(o)) {
		var self=this;
		var ret=[];
		var todo=1;
		function checkDone() {
			if (todo==0)
				callback(ret);
		}
		for (var i in o) {
			todo++;
			this._unmarshal(o[i],(function(i) {
				return function(r) {
					ret[i]=r;
					todo--;
					checkDone();
				}
			})(i),releaseDuplicate);
		}
		todo--;
		checkDone();
		return;
	}
	if (typeof(o)==="string")
		return callback(o);
	if (typeof(o)==="number")
		return callback(o);
	if (typeof(o)==="object") {
		if (o.t==="j") {
			//Similar to Array
			o=o.o;
			var self=this;
			var ret={};
			var todo=1;
			function checkDone() {
				if (todo==0)
					callback(ret);
			}
			for (var i in o) {
				todo++;
				this._unmarshal(o[i],(function(i) {
					return function(r) {
						ret[i]=r;
						todo--;
						checkDone();
					}
				})(i),releaseDuplicate);
			}
			todo--;
			checkDone();
			return;
		} else if (o.t==="o") {
			return this._unmarshalObject(o.o,callback,releaseDuplicate);
		} else {
			throw new Error("Unknown object type "+o.t);
		}
	}
	throw new Error("Unable to unmarshal "+o);
}

IPCNode.prototype.register=function(name,obj) {
	var self=this;
	this._marshalObject(obj,function(marshalledObj) {
		self._emitCommand({m:"rg",n:name,o:marshalledObj});
	});
}
IPCNode.prototype._onRegister=function(name,remoteObject) {
	var self=this;
	this._unmarshalObject(remoteObject,function(localObject) {
		self.emit("register",name,localObject);
		IPCNode.dispose(localObject);
	},true);
}
IPCNode.sync=function(f) {
	return function() {
		var args=Array.prototype.slice.call(arguments);
		if (args.length<1)
			return;
		var callback=args.pop();
		callback(f.apply(this,args));
	}
}
IPCNode.async=function(f) {
	return function() {
		var args=Array.prototype.slice.call(arguments);
		if (args.length<1)
			return;
		var lastindex=args.length-1;
		var last=args[lastindex];
		if (typeof(last)==="function") {
			var copy=IPCNode.reference(last);
			var called=false;
			args[lastindex]=function() {
				if (called)
					throw new Error("Callback function called twice");
				called=true;
				copy.apply(this,Array.prototype.slice.call(arguments));
				IPCNode.dispose(copy);
			}
		}
		f.apply(this,args);
	}
}

exports.IPCNode=IPCNode;