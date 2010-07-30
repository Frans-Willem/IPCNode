var sys=require("sys");
var EventEmitter=require("events").EventEmitter;
var IDProvider=require("./IDProvider").IDProvider;

//Helper functions
function getGlobal() {
	return (function(){return this;})();
}

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

/*************************\
* Readable stream methods *
\*************************/
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
/**************************\
* Writeable stream methods *
\**************************/
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
/****************************************\
* Internal functions for stream handling *
\****************************************/
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
IPCNode.commands={
	request:"request",
	response:"response",
	release:"release",
	call:"call",
	register:"register"
};
IPCNode.prototype._onCommand=function(cmd) {
	if (cmd.length<0)
		return;
	var c=cmd[0];
	switch (c) {
		case IPCNode.commands.response: return this._onResponse.apply(this,cmd.slice(1));
		case IPCNode.commands.request: return this._onRequest.apply(this,cmd.slice(1));
		case IPCNode.commands.release: return this._onRelease.apply(this,cmd.slice(1));
		case IPCNode.commands.call: return this._onCall.apply(this,cmd.slice(1));
		case IPCNode.commands.register: return this._onRegister.apply(this,cmd.slice(1));
		default:
			throw new Error("Unknown method: "+c+" "+cmd);
	}
}
/*************************\
* Marshalling information *
\*************************/
IPCNode.prototype._isClean=function() {
	//sys.puts("_isClean: "+JSON.stringify(Object.keys(this._localobjects))+" "+JSON.stringify(Object.keys(this._requesting))+" "+JSON.stringify(Object.keys(this._remoteobjects)));
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
/*****************************\
* Remote Object Unmarshalling *
\*****************************/
IPCNode.prototype._createRemoteObject=function(remoteInfo,remoteObjectUnmarshaller,resultCallback) {
	if (this._closed)
		throw new Error("IPCNode was closed");
	//Create stub function or object
	var ret;
	if (remoteInfo.type==="f") ret=createIPCFunction();
	else if (remoteInfo.type==="o") ret={};
	else throw new Error("Type "+t+" not supported");
	
	var self=this;
	ret.__ipc_disposed=false;
	ret.__ipc_owner=self;
	ret.__ipc_owner_info=remoteInfo;
	ret.__ipc_children=[];
	ret["__ipcinfo_"+self._id]={owner:false,id:remoteInfo.id};
	var props=remoteInfo.props;
	var todo=1;
	function checkDone() {
		if (todo==0)
			resultCallback(ret);
	}
	for (var propname in props) {
		if (propname.substr(0,2)=="__")
			continue;
		todo++;
		self._unmarshal(props[propname],remoteObjectUnmarshaller,(function(propname) {
			return function(propvalue) {
				ret[propname]=propvalue;
				ret["__ipc_children"].push(propvalue);
				todo--;
				checkDone();
			}
		})(propname));
	}
	todo--;
	checkDone();
}
function createIPCFunction() {
	return function() {
		var me=arguments.callee;
		var owner=me.__ipc_owner;
		if (typeof(owner)!=="object")
			throw new Error("Function has been disposed");
		owner._call(me,this,Array.prototype.slice.call(arguments));
	}
}
IPCNode.reference=function(obj) {
	var owner=obj.__ipc_owner;
	if (typeof(owner)!=="object")
		return obj;
	sys.puts("IPCNode.reference "+obj.__ipc_owner_info.id);
	var ret;
	var self=owner;
	//Will call back immediately seeing as all info should be readily available
	function remoteObjectUnmarshaller(id,resultCallback) {
		return self._unmarshalRemoteObject(id,remoteObjectUnmarshaller,resultCallback);
	}
	//Increase copied refcount manually
	obj.__ipc_owner_info.refcount++;
	owner._createRemoteObject(obj.__ipc_owner_info,remoteObjectUnmarshaller,function(r) {
		ret=r;
	},false);
	return ret;
}
IPCNode.dispose=function(obj) {
	if (obj.__ipc_disposed)
		throw new Error("IPC object already disposed");
	var owner=obj.__ipc_owner;
	if (typeof(owner)!=="object") {
		return;
	}
	var remoteInfo=obj.__ipc_owner_info;
	sys.puts("IPCNode.dispose "+remoteInfo.id);
	var children=obj.__ipc_children;
	delete obj.__ipc_owner;
	delete obj.__ipc_owner_info;
	delete obj.__ipc_children;
	delete obj["__ipcinfo_"+owner._id];
	obj.__ipc_disposed=true;
	owner._releaseRemoteInfo(remoteInfo);
	for (var i=0; i<children.length; i++) {
		try {
			IPCNode.dispose(children[i]);
		}
		catch(e) {
		
		}
	}
}
IPCNode.prototype._unmarshalRemoteObject=function(id,remoteObjectUnmarshaller,resultCallback) {
	//Unmarshal an object on the other side
	var id=parseInt(id);
	var self=this;
	this._requestRemoteInfo(id,function(remoteInfo) {
		self._createRemoteObject(remoteInfo,remoteObjectUnmarshaller,resultCallback);
	});
}
/*********************************\
* Object marshalling *
\*********************************/
/**
 * Will be called on a release request (called from _releaseRemoteId on other side)
 * @author fw@hardijzer.nl
 * @param {id1} First id
 * @param {id2} Second id
 * @param {idn} nth id
 * @return undefined
 */
IPCNode.prototype._onRelease=function() {
	var ids=Array.prototype.slice.call(arguments);
	for (var i=0; i<ids.length; i++) {
		var id=parseInt(ids[i]);
		var info=this._localobjects[id];
		if (typeof(info)!=="object")
			throw new Error("Unknown ID: "+id);
		if (--info.refcount == 0) {
			sys.puts("onRelease: "+id+" fully released");
			//Release it completely
			delete info.object["__ipcinfo_"+this._id];
			delete this._localobjects[id];
			this._idp.free(id);
		} else sys.puts("onRelease: "+id+" not fully released");
	}
	if (ids.length>0 && this._isClean())
		this.emit("clean");
}
/**
 * (Called from _requestRemoteProperties on other side)
 */
IPCNode.prototype._onRequest=function(id) {
	var self=this;
	var info=self._localobjects[parseInt(id)];
	if (typeof(info)!=="object")
		throw new Error("Unknown ID: "+id);
	var props={};
	var obj=info.object;
	var type=typeof(obj);
	var res=[IPCNode.commands.response,id,type.substr(0,1),props];
	var seen={};
	function refcountCallback(id) {
		id=parseInt(id);
		if (!seen[id]) {
			seen[id]=true;
			return true;
		}
		return false;
	}
	function objectMarshaller(o) {
		return self._marshalObject(o,refcountCallback);
	}
	for (var i in obj) {
		var x=obj[i];
		if (i.substr(0,2)!=="__")
			props[i]=self._marshal(x,objectMarshaller);
	}
	self._emitCommand(res);
}
/**
 * Gets remote object information (calls _onRequest on other side)
 * @param {id} Remote object id
 * @param {callback} Callback to be called with information
 */
IPCNode.prototype._requestRemoteInfo=function(id,callback) {
	id=parseInt(id);
	var cached=this._remoteobjects[id];
	if (typeof(cached)==="object") {
		cached.refcount++;
		callback(cached);
		return;
	}
	var requesting=this._requesting[id];
	if (typeof(requesting)==="object") {
		requesting.push(callback);
		return;
	}
	this._requesting[id]=[callback];
	this._emitCommand([IPCNode.commands.request,id]);
	return;
}
IPCNode.prototype._haveRemoteReference=function(id) {
	id=parseInt(id);
	return ((typeof(this._remoteobjects[id])==="object") || (typeof(this._requesting[id])==="object"));
}
/**
 * 
 */
IPCNode.prototype._onResponse=function(id,type,props) {
	var id=parseInt(id);
	var req=this._requesting[id];
	if (typeof(req)!=="object")
		throw new Error("Invalid request ID in response")
	delete this._requesting[id];
	var remoteInfo={id:id,refcount:1, type:type,props:props};
	this._remoteobjects[id]=remoteInfo;
	while (req.length>0) {
		remoteInfo.refcount++;
		req.shift()(remoteInfo);
	}
	this._releaseRemoteInfo(remoteInfo);
}
/**
 * Release remote id (calls _onRelease on other side)
 * @param {id} id of object
 * @param {info} local information object
 * @return undefined
 */
IPCNode.prototype._releaseRemoteInfo=function(remoteInfo) {
	//Do nothing for now
	if (typeof(remoteInfo)!=="object")
		throw new Error("Unhandled error on releasing");
	if (--remoteInfo.refcount == 0) {
		delete this._remoteobjects[remoteInfo.id];
		this._emitCommand([IPCNode.commands.release,remoteInfo.id]);
	}
	if (this._isClean())
		this.emit("clean");
}
/*************************\
* Local value marshalling *
\*************************/
IPCNode.prototype._marshal=function(o,objectMarshaller) {
	if (Array.isArray(o)) {
		var self=this;
		return o.map(function(x) { return self._marshal(x,objectMarshaller); });
	}
	if (o===null || o===undefined || typeof(o)==="number" || typeof(o)==="string" || typeof(o)==="boolean")
		return o;
	if (typeof(o)==="object" || typeof(o)==="function")
		return objectMarshaller(o);
	throw new Error("Unable to marshal value: "+o);
}
IPCNode.objecttypes={
	mine: "mine",
	yours: "yours",
	global: "global"
};
IPCNode.prototype._marshalObject=function(o,refcountCallback) {
	if (o===getGlobal())
		return {t:IPCNode.objecttypes.global};
	var info=o["__ipcinfo_"+this._id];
	if (typeof(info)==="object") {
		if (info.owner) {
			if (refcountCallback(info.id))
				this._localobjects[info.id].refcount++;
			return {t:IPCNode.objecttypes.mine,i:info.id};
		} else {
			return {t:IPCNode.objecttypes.yours,i:info.id};
		}
	} else {
		//Allocate new
		info={owner:true,id:this._idp.alloc()};
		o["__ipcinfo_"+this._id]=info;
		this._localobjects[info.id]={
			refcount: refcountCallback(info.id)?1:0,
			object: o
		};
		return {t:IPCNode.objecttypes.mine,i:info.id};
	}
}
/************************\
* Cross-boundary calling *
\************************/
IPCNode.prototype._call=function(f,t,args) {
	if (this._closed)
		throw new Error("IPCNode was closed");
	var self=this;
	var seen={};
	function refcountCallback(id) {
		id=parseInt(id);
		if (!seen[id]) {
			seen[id]=true;
			return true;
		}
		return false;
	}
	function objectMarshaller(o) {
		return self._marshalObject(o,refcountCallback);
	}
	var localArgs=[f,t].concat(args);
	var marshalledArgs=localArgs.map(function(v) {return self._marshal(obj,objectMarshaller); });
	self._emitCommand([IPCNode.commands.call,{}].concat(marshalledArgs));
}
IPCNode.prototype._onCall=function() {
	var args=Array.prototype.slice.call(arguments,2);
	var self=this;
	
	this._unmarshalArguments(arguments,function(f,t) {
		var args=Array.prototype.slice.call(arguments,2);
		f.apply(t,args);
		IPCNode.dispose(f);
		IPCNode.dispose(t);
		args.forEach(function(a) {
			IPCNode.dispose(a);
		});
	});
}
IPCNode.prototype.register=function(name,obj) {
	if (this._closed)
		throw new Error("IPCNode was closed");
	var self=this;
	var seen={};
	function refcountCallback(id) {
		id=parseInt(id);
		if (!seen[id]) {
			seen[id]=true;
			return true;
		}
		return false;
	}
	function objectMarshaller(o) {
		return self._marshalObject(o,refcountCallback);
	}
	var args=Array.prototype.slice.call(arguments,0);
	var marshalledArgs=args.map(function(v) {return self._marshal(obj,objectMarshaller); });
	self._emitCommand([IPCNode.commands.register,{}].concat(marshalledArgs));
}
IPCNode.prototype._onRegister=function() {
	var self=this;
	this._unmarshalArguments(arguments,function(name,object) {
		self.emit("register",name,object);
		IPCNode.dispose(object);
	});
}
/*************\
* End section *
\*************/
IPCNode.prototype._unmarshalArguments=function(args,resultCallback) {
	var infoCache=args[0];
	var marshalledArgs=Array.prototype.slice.call(args,1);
	var resultCallback=marshalledArgs.pop();
	var ret=[];
	var self=this;
	function remoteObjectUnmarshaller(id,resultCallback) {
		if (self._haveRemoteReference(id))
			self._emitCommand([IPCNode.commands.release,id]);
		self._unmarshalRemoteObject(id,remoteObjectUnmarshaller,resultCallback);
	}
	var todo=1;
	function checkDone() {
		if (todo==0)
			resultCallback.apply(this,ret);
	}
	marshalledArgs.forEach(function(marshalledValue,key) {
		todo++;
		self._unmarshal(marshalledValue,remoteObjectUnmarshaller,function(value) {
			ret[key]=value;
			todo--;
			checkDone();
		});
	});
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
IPCNode.prototype._unmarshalObject=function(info,remoteObjectUnmarshaller,resultCallback) {
	if (info.t===IPCNode.objecttypes.mine) remoteObjectUnmarshaller(info.i,resultCallback);
	else if (info.t===IPCNode.objecttypes.yours) this._unmarshalLocalObject(info.i,resultCallback);
	else if (info.t===IPCNode.objecttypes.global) return resultCallback(getGlobal());
	else throw new Error("Unknown object-type: "+info.t);
}
IPCNode.prototype._unmarshal=function(o,remoteObjectUnmarshaller,resultCallback) {
	if (Array.isArray(o)) {
		var self=this;
		var ret=[];
		var todo=1;
		function checkDone() {
			if (todo==0)
				resultCallback(ret);
		}
		o.forEach(function(value,key) {
			self._unmarshal(value,objectUnmarshaller,function(unmarshalledValue) {
				ret[key]=unmarshalledValue;
				todo--;
				checkDone();
			});
			todo++;
		});
		todo--;
		checkDone();
		return;
	}
	if (typeof(o)==="string")
		return resultCallback(o);
	if (typeof(o)==="number")
		return resultCallback(o);
	if (typeof(o)==="object")
		return this._unmarshalObject(o,remoteObjectUnmarshaller,resultCallback);
	throw new Error("Unable to unmarshal "+o);
}
/******************\
* Helper functions *
\******************/
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